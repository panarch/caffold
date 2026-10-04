//! Updating the installed Caffold app to a newer release.
//!
//! `caffold update` backs the app up, lets Homebrew install the new version,
//! restarts the app, and puts the backup back when the new version does not
//! start. Each attempt is recorded in the data directory's `caffold-updates`,
//! where the server reads the outcome. The server also asks GitHub for the
//! newest release.

mod host;
mod procedure;
mod records;
mod release;

use std::{io, process::ExitCode};

pub(crate) use host::{homebrew_record, process_alive};
pub(crate) use procedure::{HomebrewRecord, UpdateRequest};
pub(crate) use records::{Attempt, AttemptOutcome, AttemptRecords};
pub(crate) use release::{LatestRelease, fetch_latest_release};

/// The data directory's update records. An update Task works here too.
pub(crate) const UPDATES_DIRECTORY: &str = "caffold-updates";

/// Starts an attempt and reports it until it ends, or, as the worker that
/// `caffold update` starts, runs `attempt` to its outcome.
pub(crate) async fn run(request: UpdateRequest, attempt: Option<String>) -> ExitCode {
    let records = AttemptRecords::new(request.data_dir.join(UPDATES_DIRECTORY));
    let updated = match attempt {
        Some(id) => {
            procedure::run_attempt(&host::MacHost, &records, &request, &id).await;
            true
        }
        None => procedure::start(&host::MacHost, &records, &request, &mut io::stdout()).await,
    };
    if updated {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
