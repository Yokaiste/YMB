use std::sync::{Condvar, Mutex, OnceLock};

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub threads: usize,
    pub memory_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            threads: std::thread::available_parallelism().map_or(1, usize::from),
            memory_bytes: 512 << 20,
        }
    }
}

impl Limits {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let positive = |name: &str| {
            std::env::var(name)
                .ok()?
                .parse::<usize>()
                .ok()
                .filter(|n| *n > 0)
        };
        Self {
            threads: positive("YMB_WORKER_THREADS")
                .unwrap_or(defaults.threads)
                .min(defaults.threads),
            memory_bytes: positive("YMB_MEMORY_BUDGET_MIB")
                .map(|mib| mib.saturating_mul(1 << 20))
                .unwrap_or(defaults.memory_bytes),
        }
    }
}

struct Queue {
    pending: Vec<(usize, usize)>,
    used: usize,
}

pub struct Cost {
    pub memory_bytes: usize,
    pub work_bytes: usize,
}
impl From<usize> for Cost {
    fn from(bytes: usize) -> Self {
        Self {
            memory_bytes: bytes,
            work_bytes: bytes,
        }
    }
}

struct Reservation<'a> {
    queue: &'a Mutex<Queue>,
    ready: &'a Condvar,
    bytes: usize,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).used -= self.bytes;
        self.ready.notify_all();
    }
}

/// Return independent results in input order, admitting jobs by their estimated peak memory.
pub fn map<T: Sync, R: Send + Sync, C: Into<Cost>>(
    items: &[T],
    limits: Limits,
    memory: impl Fn(&T) -> C,
    run: impl Fn(&T) -> R + Sync,
) -> Vec<R> {
    let budget = limits.memory_bytes.max(1);
    let costs: Vec<Cost> = items.iter().map(|item| memory(item).into()).collect();
    let total = costs
        .iter()
        .fold(0usize, |sum, cost| sum.saturating_add(cost.work_bytes));
    // Small batches cost less to execute directly than to distribute to OS threads.
    let workers = limits
        .threads
        .max(1)
        .min(items.len())
        .min((total / (256 << 10)).max(1));
    if workers <= 1 {
        return items.iter().map(run).collect();
    }
    let queue = Mutex::new(Queue {
        pending: costs
            .into_iter()
            .enumerate()
            .map(|(i, cost)| (i, cost.memory_bytes.max(1).min(budget)))
            .collect(),
        used: 0,
    });
    let ready = Condvar::new();
    let results: Vec<_> = items.iter().map(|_| OnceLock::new()).collect();
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let (queue, ready, results, run) = (&queue, &ready, &results, &run);
            scope.spawn(move || {
                loop {
                    let mut state = queue.lock().unwrap_or_else(|e| e.into_inner());
                    let (index, bytes) = loop {
                        if state.pending.is_empty() {
                            return;
                        }
                        if let Some(position) = state
                            .pending
                            .iter()
                            .position(|(_, bytes)| *bytes <= budget - state.used)
                        {
                            let job = state.pending.swap_remove(position);
                            state.used += job.1;
                            break job;
                        }
                        state = ready.wait(state).unwrap_or_else(|e| e.into_inner());
                    };
                    drop(state);
                    let _reservation = Reservation {
                        queue,
                        ready,
                        bytes,
                    };
                    assert!(results[index].set(run(&items[index])).is_ok());
                }
            });
        }
    });
    results
        .into_iter()
        .map(|result| result.into_inner().expect("worker omitted a result"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn a_large_job_does_not_serialize_smaller_jobs_or_change_result_order() {
        let mib = 1 << 20;
        let costs = [7 * mib, mib, mib, mib];
        let paired = Barrier::new(2);
        let used = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let result = map(
            &[0, 1, 2, 3],
            Limits {
                threads: 4,
                memory_bytes: 8 * mib,
            },
            |i| costs[*i],
            |i| {
                let current = used.fetch_add(costs[*i], Ordering::SeqCst) + costs[*i];
                assert!(current <= 8 * mib);
                peak.fetch_max(current, Ordering::SeqCst);
                if *i < 2 {
                    paired.wait();
                }
                used.fetch_sub(costs[*i], Ordering::SeqCst);
                i * 2
            },
        );
        assert_eq!(result, [0, 2, 4, 6]);
        assert_eq!(peak.load(Ordering::SeqCst), 8 * mib);
    }

    #[test]
    fn empty_small_and_oversized_batches_finish() {
        assert!(map::<usize, usize, _>(&[], Limits::default(), |_| 1usize, |i| *i).is_empty());
        assert_eq!(
            map(
                &[1, 2],
                Limits {
                    threads: 4,
                    memory_bytes: 1
                },
                |_| usize::MAX,
                |i| i * 2
            ),
            [2, 4]
        );
    }

    #[test]
    fn streaming_work_uses_multiple_workers_without_reserving_the_entire_file() {
        let paired = Barrier::new(2);
        let result = map(
            &[1, 2],
            Limits {
                threads: 2,
                memory_bytes: 128 << 10,
            },
            |_| Cost {
                memory_bytes: 64 << 10,
                work_bytes: 8 << 20,
            },
            |i| {
                paired.wait();
                i * 2
            },
        );
        assert_eq!(result, [2, 4]);
    }

    #[test]
    #[should_panic(expected = "a scoped thread panicked")]
    fn panics_release_memory_for_waiting_workers() {
        map(
            &[0, 1, 2],
            Limits {
                threads: 3,
                memory_bytes: 1 << 20,
            },
            |_| 1usize << 20,
            |i| {
                assert_ne!(*i, 0, "deliberate worker panic");
            },
        );
    }
}
