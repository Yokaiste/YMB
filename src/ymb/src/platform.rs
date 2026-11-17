pub use ymb_core::terminal::{InputBlock, wait_for_enter};

#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    // The handle is checked before use and is closed on every successful open.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut code = 0;
        let queried = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        queried == 0 || code == 259
    }
}
#[cfg(not(windows))]
pub fn process_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Job {
    fn attach(child: &std::process::Child, memory_mib: usize) -> ymb_core::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        // The job owns a checked handle; closing it terminates descendants as well.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(process_error(std::io::Error::last_os_error()));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | if memory_mib > 0 {
                    JOB_OBJECT_LIMIT_PROCESS_MEMORY
                } else {
                    0
                };
            limits.ProcessMemoryLimit = memory_mib.saturating_mul(1024 * 1024);
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(process_error(error));
            }
            Ok(Self(handle))
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
pub struct Process {
    pub child: std::process::Child,
    #[cfg(windows)]
    job: Option<Job>,
}
impl Process {
    pub fn usage(&self) -> Option<(f64, Option<u64>)> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{
                Foundation::FILETIME,
                System::{
                    ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
                    Threading::GetProcessTimes,
                },
            };
            // The child owns a live process handle; both output structs are plain C data.
            unsafe {
                let zero = FILETIME {
                    dwLowDateTime: 0,
                    dwHighDateTime: 0,
                };
                let [mut created, mut exited, mut kernel, mut user] = [zero; 4];
                let handle = self.child.as_raw_handle();
                if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
                    return None;
                }
                let ticks = |time: FILETIME| {
                    ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64
                };
                let mut memory: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
                memory.cb = std::mem::size_of_val(&memory) as u32;
                let peak = (K32GetProcessMemoryInfo(handle, &mut memory, memory.cb) != 0)
                    .then_some(memory.PeakPagefileUsage as u64);
                Some(((ticks(kernel) + ticks(user)) as f64 / 10000., peak))
            }
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
    pub fn spawn(
        executable: &std::path::Path,
        directory: &std::path::Path,
        limits: ymb_core::parallel::Limits,
    ) -> ymb_core::Result<Self> {
        let mut command = std::process::Command::new(executable);
        command
            .current_dir(directory)
            .env("YMB_WORKER_THREADS", limits.threads.to_string())
            .env(
                "YMB_MEMORY_BUDGET_MIB",
                (limits.memory_bytes / (1 << 20)).to_string(),
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        Self::spawn_command(&mut command, limits.memory_bytes / (1 << 20))
    }
    fn spawn_command(
        command: &mut std::process::Command,
        memory_mib: usize,
    ) -> ymb_core::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| {
            ymb_core::Diagnostic::io(std::path::Path::new(command.get_program()), e)
        })?;
        #[cfg(windows)]
        let job = match Job::attach(&child, memory_mib) {
            Ok(job) => Some(job),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        #[cfg(not(windows))]
        let _ = memory_mib;
        Ok(Self {
            child,
            #[cfg(windows)]
            job,
        })
    }
    pub fn terminate(&mut self) {
        #[cfg(windows)]
        {
            self.job.take();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.terminate();
    }
}
#[cfg(windows)]
fn process_error(error: std::io::Error) -> Box<ymb_core::Diagnostic> {
    ymb_core::Diagnostic::new(
        "GeneratorError",
        crate::messages::format(
            "platform.process_error.cannot_isolate_generator_process_error",
            &[("ERROR", format!("{}", error))],
        ),
        crate::messages::text("platform.process_error.run_ymb_in_a_windows_session_that"),
    )
}

pub fn capture(
    command: &mut std::process::Command,
    timeout: std::time::Duration,
) -> ymb_core::Result<std::process::Output> {
    capture_inner(command, Some(timeout), false)
}

pub fn capture_with_progress(
    command: &mut std::process::Command,
    enabled: bool,
) -> ymb_core::Result<std::process::Output> {
    capture_inner(command, None, enabled && crate::ui::Ui::stderr().rich)
}

fn capture_inner(
    command: &mut std::process::Command,
    timeout: Option<std::time::Duration>,
    progress: bool,
) -> ymb_core::Result<std::process::Output> {
    use std::{
        io::Read,
        process::Stdio,
        time::{Duration, Instant},
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = Process::spawn_command(command, 0)?;
    fn drain(
        mut input: impl Read,
        limit: usize,
        progress: bool,
    ) -> std::io::Result<(Vec<u8>, bool)> {
        let mut bytes = Vec::new();
        let mut buffer = [0; 8192];
        let mut truncated = false;
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            if progress
                && let Some(line) = String::from_utf8_lossy(&buffer[..count])
                    .lines()
                    .rev()
                    .find(|line| !line.trim().is_empty())
            {
                crate::ui::phase(line.trim().chars().take(1000).collect());
            }
            let keep = count.min(limit - bytes.len());
            bytes.extend_from_slice(&buffer[..keep]);
            truncated |= keep < count;
        }
        Ok((bytes, truncated))
    }
    let stdout = process.child.stdout.take().unwrap();
    let stderr = process.child.stderr.take().unwrap();
    let output = std::thread::spawn(move || drain(stdout, 16 * 1024 * 1024, progress));
    let errors = std::thread::spawn(move || drain(stderr, 1024 * 1024, progress));
    let deadline = timeout
        .map(|timeout| {
            Instant::now().checked_add(timeout).ok_or_else(|| {
                ymb_core::Diagnostic::new(
                    "ConfigError",
                    crate::messages::text(
                        "common.shared.configured_timeout_exceeds_the_supported_clock_range",
                    ),
                    crate::messages::text("platform.capture_inner.reduce_generatortimeoutseconds"),
                )
            })
        })
        .transpose()?;
    let status = loop {
        match process.child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if deadline.is_none_or(|deadline| Instant::now() < deadline) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Ok(None) => {
                break Err(ymb_core::Diagnostic::new(
                    "GeneratorError",
                    crate::messages::text(
                        "platform.capture_inner.generator_compilation_exceeded_its_time_limit",
                    ),
                    crate::messages::text(
                        "platform.capture_inner.fix_the_stalled_compiler_or_dependency_download",
                    ),
                )
                .code("E24"));
            }
            Err(error) => {
                break Err(ymb_core::Diagnostic::new(
                    "GeneratorError",
                    error.to_string(),
                    crate::messages::text("platform.capture_inner.check_the_compiler_process"),
                ));
            }
        }
    };
    process.terminate();
    let (stdout, truncated) = output
        .join()
        .map_err(|_| {
            ymb_core::Diagnostic::new(
                "GeneratorError",
                crate::messages::text("platform.capture_inner.compiler_output_reader_panicked"),
                crate::messages::text("platform.capture_inner.retry_compilation"),
            )
        })?
        .map_err(|e| {
            ymb_core::Diagnostic::new(
                "GeneratorError",
                e.to_string(),
                crate::messages::text("platform.capture_inner.check_compiler_output"),
            )
        })?;
    let (stderr, _) = errors
        .join()
        .map_err(|_| {
            ymb_core::Diagnostic::new(
                "GeneratorError",
                crate::messages::text("platform.capture_inner.compiler_diagnostic_reader_panicked"),
                crate::messages::text("platform.capture_inner.retry_compilation"),
            )
        })?
        .map_err(|e| {
            ymb_core::Diagnostic::new(
                "GeneratorError",
                e.to_string(),
                crate::messages::text("platform.capture_inner.check_compiler_diagnostics"),
            )
        })?;
    if truncated {
        return Err(ymb_core::Diagnostic::new(
            "GeneratorError",
            crate::messages::text(
                "platform.capture_inner.compiler_output_exceeds_the_16_mib_control",
            ),
            crate::messages::text("platform.capture_inner.reduce_build_script_output"),
        ));
    }
    Ok(std::process::Output {
        status: status?,
        stdout,
        stderr,
    })
}
