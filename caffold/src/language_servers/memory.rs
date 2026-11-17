//! How much memory a running language server holds: its resident set size.
//! Linux reads it from `/proc`; elsewhere `ps` reports it, which keeps the
//! reading free of `unsafe` calls into the system.

/// Resident bytes of process `pid`, or `None` once it is gone or cannot be
/// read. Blocks while it reads.
pub(super) fn resident_bytes(pid: u32) -> Option<u64> {
    resident_kibibytes(pid).map(|kibibytes| kibibytes * 1024)
}

#[cfg(target_os = "linux")]
fn resident_kibibytes(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|value| value.trim().strip_suffix("kB"))
        .and_then(|value| value.trim().parse().ok())
}

#[cfg(not(target_os = "linux"))]
fn resident_kibibytes(pid: u32) -> Option<u64> {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_process_reports_its_resident_memory() {
        let bytes = resident_bytes(std::process::id()).unwrap();

        assert!(bytes > 1024 * 1024, "{bytes} bytes");
    }

    #[test]
    fn a_process_that_is_gone_reports_nothing() {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();

        assert_eq!(resident_bytes(pid), None);
    }
}
