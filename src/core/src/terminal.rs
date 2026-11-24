#[cfg(windows)]
struct ConsoleInput(u32);
#[cfg(windows)]
impl ConsoleInput {
    fn quiet() -> Option<Self> {
        use windows_sys::Win32::System::Console::*;
        // Only a real console is changed; the original mode is restored by Drop.
        unsafe {
            let input = GetStdHandle(STD_INPUT_HANDLE);
            let mut mode = 0;
            if GetConsoleMode(input, &mut mode) == 0
                || SetConsoleMode(input, mode & !(ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT)) == 0
            {
                return None;
            }
            FlushConsoleInputBuffer(input);
            Some(Self(mode))
        }
    }
    fn discard() {
        use windows_sys::Win32::System::Console::*;
        unsafe {
            FlushConsoleInputBuffer(GetStdHandle(STD_INPUT_HANDLE));
        }
    }
}
#[cfg(windows)]
impl Drop for ConsoleInput {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Console::*;
        unsafe {
            let input = GetStdHandle(STD_INPUT_HANDLE);
            FlushConsoleInputBuffer(input);
            SetConsoleMode(input, self.0);
        }
    }
}

pub struct InputBlock {
    #[cfg(windows)]
    running: Option<(
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<()>,
        ConsoleInput,
    )>,
}
impl InputBlock {
    pub fn new(enabled: bool) -> Self {
        #[cfg(windows)]
        {
            let running = if enabled {
                ConsoleInput::quiet().map(|mode| {
                    let (sender, receiver) = std::sync::mpsc::channel();
                    let thread = std::thread::spawn(move || {
                        while receiver
                            .recv_timeout(std::time::Duration::from_millis(40))
                            .is_err_and(|e| e == std::sync::mpsc::RecvTimeoutError::Timeout)
                        {
                            ConsoleInput::discard();
                        }
                    });
                    (sender, thread, mode)
                })
            } else {
                None
            };
            Self { running }
        }
        #[cfg(not(windows))]
        {
            let _ = enabled;
            Self {}
        }
    }
}
impl Drop for InputBlock {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some((sender, thread, mode)) = self.running.take() {
            drop(sender);
            let _ = thread.join();
            drop(mode);
        }
    }
}

pub fn wait_for_enter() -> crate::Result<()> {
    #[cfg(windows)]
    if let Some(_mode) = ConsoleInput::quiet() {
        use windows_sys::Win32::System::Console::*;
        loop {
            let mut event = INPUT_RECORD::default();
            let mut count = 0;
            // Read one checked console event; non-Enter keys are discarded without echo.
            unsafe {
                if ReadConsoleInputW(GetStdHandle(STD_INPUT_HANDLE), &mut event, 1, &mut count) == 0
                {
                    return Err(crate::Diagnostic::io(
                        std::path::Path::new("stdin"),
                        std::io::Error::last_os_error(),
                    ));
                }
                if count != 0
                    && u32::from(event.EventType) == KEY_EVENT
                    && event.Event.KeyEvent.bKeyDown != 0
                    && event.Event.KeyEvent.wVirtualKeyCode == 13
                {
                    return Ok(());
                }
            }
        }
    }
    let mut input = String::new();
    std::io::stdin()
        .read_line(&mut input)
        .map(|_| ())
        .map_err(|e| crate::Diagnostic::io(std::path::Path::new("stdin"), e))
}

pub fn enable_ansi() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::*;
        // Redirected streams do not have console modes.
        unsafe {
            for stream in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
                let handle = GetStdHandle(stream);
                let mut mode = 0;
                if GetConsoleMode(handle, &mut mode) != 0 {
                    SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
                }
            }
        }
    }
}
