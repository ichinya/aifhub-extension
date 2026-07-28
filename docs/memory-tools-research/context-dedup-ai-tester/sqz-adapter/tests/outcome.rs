use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn unchanged_fresh_output_is_classified_as_full() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must be after the Unix epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "sqz-adapter-outcome-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).expect("temporary adapter directory");
    let store = root.join("sessions.db");
    let input = "DEPLOY_GENERATION=17\nCHANGE_SENTINEL=before-cobalt\n";

    let mut child = Command::new(env!("CARGO_BIN_EXE_sqz-isolated-adapter"))
        .arg("--store")
        .arg(&store)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("adapter binary must start");
    child
        .stdin
        .take()
        .expect("adapter stdin")
        .write_all(input.as_bytes())
        .expect("adapter input");
    let output = child.wait_with_output().expect("adapter output");
    let _ = std::fs::remove_dir_all(&root);

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), input);
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("outcome=full"),
        "unchanged output must not be reported as compressed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
