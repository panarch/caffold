//! Starting the agent, one process at a time.
//!
//! Every `claude` start is the same moment to the account it runs as: within
//! about a second the process reaches for the stored credentials, and one that
//! finds them expiring refreshes them — a write that replaces the token it
//! read. Two processes young at once can both read that one token, and the
//! second refresh presents a token already spent. The service reads that as
//! theft and revokes the whole grant: every surface signed in as this account
//! is signed out at once.
//!
//! So there is one door. A start — a session the runner spawns, or a one-off
//! question asked directly — passes through it alone, and the door stays shut
//! a moment longer so the process is past its credential check before the next
//! begins. Questions answered from what is already on this machine, like
//! `--version` and `auth status`, refresh nothing and do not pass the door.
//!
//! The door is this backend's, and it narrows the race rather than abolishing
//! it. It orders every start this process makes; it cannot see a second
//! backend on the same account, `claude` run by hand in a terminal, or the
//! starts a previous backend made before a restart — and a refresh slower
//! than the spacing can still overlap the next start. Ending the race outright
//! belongs to the agent's own credential handling; the door keeps Caffold from
//! being the one to provoke it.

use std::time::Duration;

use tokio::sync::{Mutex as AsyncMutex, MutexGuard};
use tokio::time::Instant;

/// How long the door stays shut behind each start: the second a fresh process
/// takes to reach the stored credentials, and another for the round trip a
/// refresh takes to write the replacement back.
const SPACING: Duration = Duration::from_secs(2);

/// The one door every authenticating start this backend makes passes through.
pub(super) struct StartGate {
    spacing: Duration,
    /// When the last process was set running, and nothing before the first.
    last_start: AsyncMutex<Option<Instant>>,
}

impl StartGate {
    pub(super) fn spaced() -> Self {
        Self::with_spacing(SPACING)
    }

    /// A door that holds starts to one at a time but never spaces them. A
    /// stand-in runner spawns nothing, so there is no credential check to
    /// space — only tests that would otherwise slow by [`SPACING`] for every
    /// session past the first.
    #[cfg(test)]
    pub(super) fn unspaced() -> Self {
        Self::with_spacing(Duration::ZERO)
    }

    fn with_spacing(spacing: Duration) -> Self {
        Self {
            spacing,
            last_start: AsyncMutex::new(None),
        }
    }

    /// When the door last recorded a start, so a test can pin what counts as
    /// one.
    #[cfg(test)]
    pub(super) async fn stamped_at_for_tests(&self) -> Option<Instant> {
        *self.last_start.lock().await
    }

    /// Pass the door: wait for whoever is in it, then for the spacing behind
    /// the last start. A session could be waited on instead — the agent
    /// answers a greeting — but that would put its cold start in front of
    /// every Task somebody creates, and a greeting would not prove the
    /// credential write finished anyway. So what the door promises is only
    /// that starts begin one at a time, far enough apart.
    pub(super) async fn one_at_a_time(&self) -> Starting<'_> {
        let last_start = self.last_start.lock().await;
        if let Some(last_start) = *last_start {
            tokio::time::sleep_until(last_start + self.spacing).await;
        }
        Starting {
            last_start,
            stamp: true,
        }
    }
}

/// One start going through the door. Held while the start is initiated, and
/// stamped when dropped, so the spacing is measured from the moment the
/// process was set running rather than from the moment it was asked for.
pub(super) struct Starting<'gate> {
    last_start: MutexGuard<'gate, Option<Instant>>,
    stamp: bool,
}

impl Starting<'_> {
    /// Let the door go without shutting it: this passage provably began no
    /// process. The runner handing back a session it already held, or a spawn
    /// that failed outright, starts nothing worth spacing the next start
    /// behind.
    pub(super) fn nothing_started(mut self) {
        self.stamp = false;
    }
}

impl Drop for Starting<'_> {
    fn drop(&mut self) {
        // Stamped unless the passage proved otherwise: an open whose reply
        // was lost may still have left a process running, and counting it
        // costs the next start the spacing, not a login.
        if self.stamp {
            *self.last_start = Some(Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_start_on_the_heels_of_another_waits_out_the_spacing() {
        let gate = StartGate::spaced();
        let opened = Instant::now();

        drop(gate.one_at_a_time().await);
        drop(gate.one_at_a_time().await);

        assert_eq!(
            opened.elapsed(),
            SPACING,
            "the second start begins the spacing after the first, not beside it"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_start_long_after_the_last_passes_without_waiting() {
        let gate = StartGate::spaced();
        drop(gate.one_at_a_time().await);
        tokio::time::advance(SPACING * 3).await;

        let reached = Instant::now();
        drop(gate.one_at_a_time().await);

        assert_eq!(
            reached.elapsed(),
            Duration::ZERO,
            "the door costs nothing when starts are already far apart"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_passage_that_began_nothing_does_not_hold_the_next_start_back() {
        let gate = StartGate::spaced();

        gate.one_at_a_time().await.nothing_started();
        let reached = Instant::now();
        drop(gate.one_at_a_time().await);

        assert_eq!(
            reached.elapsed(),
            Duration::ZERO,
            "a session handed back rather than spawned leaves the door open"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_door_holds_the_next_start_until_the_one_in_it_is_through() {
        let gate = Arc::new(StartGate::unspaced());
        let in_the_door = gate.one_at_a_time().await;

        let mut waiting = tokio::spawn({
            let gate = gate.clone();
            async move { drop(gate.one_at_a_time().await) }
        });
        tokio::time::timeout(Duration::from_millis(10), &mut waiting)
            .await
            .expect_err("the door does not open while a start is in it");

        drop(in_the_door);
        waiting.await.expect("the held start goes through");
    }
}
