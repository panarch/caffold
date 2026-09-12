//! Ephemeral conversation retention removes whole turns. Partial observations
//! remain partial until the provider supplies a complete history baseline.
//!
//! The latest turn and one historical continuation are protected. The item
//! budget only removes other completed turns; it never asks the provider to
//! fill unused capacity. Publication order survives ordinary eviction.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[cfg(test)]
use super::TaskEventSnapshot;
use crate::agent::{Turn, TurnPage, TurnStatus};
#[cfg(test)]
use std::collections::HashSet;

use super::{
    TaskEventObservation, TaskEventObservationSource, TaskEventPublication, TaskEventRecord,
    TaskHistoryCursor, TaskHistoryPage, advance_cached_observation, project_primary_record,
    provider_lifecycle_regresses, sort_task_events, task_event_turn_id,
};

pub(super) const RETAINED_ITEM_LIMIT: usize = 300;

#[derive(Default)]
struct ThreadEvents {
    turns: HashMap<String, CachedTurn>,
    supplemental: Vec<TaskEventObservation>,
    latest: Option<String>,
    latest_revision: u64,
    historical: Option<String>,
    access: u64,
    revision: u64,
    history_request: u64,
    pages: HashMap<Option<String>, PageTurns>,
}

struct PageTurns {
    ids: Vec<String>,
    next: Option<String>,
    base_revision: u64,
}

struct CachedTurn {
    events: Vec<TaskEventObservation>,
    anchor_ms: u64,
    complete_live: bool,
    mixed_sources: bool,
    terminal: bool,
    history_revision: Option<u64>,
    access: u64,
}

#[derive(Clone, Default)]
pub(super) struct TurnEventCache {
    state: Arc<Mutex<HashMap<String, ThreadEvents>>>,
}

impl TurnEventCache {
    pub(super) fn record_observation(
        &self,
        mut event: TaskEventRecord,
        source: TaskEventObservationSource,
        session_revision: Option<u64>,
    ) -> TaskEventPublication {
        let mut state = self.state.lock().expect("conversation cache lock");
        let thread = state.entry(event.thread_id.clone()).or_default();
        thread.revision = thread.revision.saturating_add(1);
        thread.access = thread.access.saturating_add(1);
        let revision = thread.revision;
        let turn_id = task_event_turn_id(&event).map(str::to_string);
        let events = if let Some(turn_id) = turn_id {
            let turn = thread
                .turns
                .entry(turn_id.clone())
                .or_insert_with(|| CachedTurn::new(event.position.anchor_ms, thread.access));
            turn.access = thread.access;
            if source == TaskEventObservationSource::ProviderLifecycle {
                match event.event_type.as_str() {
                    "turn_started" => {
                        turn.complete_live = true;
                        if !turn.terminal {
                            thread.latest = Some(turn_id.clone());
                            thread.latest_revision =
                                session_revision.unwrap_or(thread.latest_revision);
                            let page = thread.pages.entry(None).or_insert_with(|| PageTurns {
                                ids: Vec::new(),
                                next: None,
                                base_revision: 0,
                            });
                            if !page.ids.contains(&turn_id) {
                                page.ids.insert(0, turn_id.clone());
                            }
                        }
                    }
                    "turn_completed" => turn.terminal = true,
                    _ => {}
                }
            }
            if thread.latest.is_none() && source != TaskEventObservationSource::LocalProjection {
                thread.latest = Some(turn_id.clone());
                let page = thread.pages.entry(None).or_insert_with(|| PageTurns {
                    ids: Vec::new(),
                    next: None,
                    base_revision: 0,
                });
                if !page.ids.contains(&turn_id) {
                    page.ids.insert(0, turn_id);
                }
            }
            if event.event_type != "turn_completed" {
                event.position.anchor_ms = turn.anchor_ms;
                event.position.index = if event.event_type == "turn_started" {
                    0
                } else {
                    turn.events
                        .iter()
                        .filter(|entry| entry.event.position.anchor_ms == turn.anchor_ms)
                        .map(|entry| entry.event.position.index)
                        .max()
                        .unwrap_or(0)
                        .saturating_add(1)
                };
            }
            &mut turn.events
        } else {
            &mut thread.supplemental
        };
        if let Some(existing) = events.iter_mut().find(|entry| entry.event.id == event.id) {
            let (merged, source, session_revision) =
                advance_cached_observation(existing, event, source, session_revision);
            existing.event = merged;
            existing.source = source;
            existing.session_revision = session_revision;
            existing.publication_revision = revision;
            event = existing.event.clone();
        } else {
            events.push(TaskEventObservation {
                event: event.clone(),
                publication_revision: revision,
                session_revision,
                source,
            });
        }
        thread.evict();
        TaskEventPublication { revision, event }
    }

    /// Accept one read under the same lock used by live publication. Callers
    /// capture the response and continuation before trimming its retained copy.
    pub(super) fn accept_page(
        &self,
        thread_id: &str,
        page: &TurnPage,
        mut by_turn: HashMap<String, Vec<TaskEventRecord>>,
        base_revision: u64,
        cursor: Option<&str>,
    ) -> TaskHistoryPage {
        let mut state = self.state.lock().expect("conversation cache lock");
        let thread = state.entry(thread_id.to_string()).or_default();
        let mut events = Vec::new();
        for (index, turn) in page.turns.iter().enumerate() {
            events.extend(thread.accept_history(
                turn,
                by_turn.remove(&turn.id).unwrap_or_default(),
                base_revision,
                cursor.is_none() && index == 0,
            ));
        }
        thread.remember_page(cursor, page, base_revision);
        sort_task_events(&mut events);
        thread.revision = thread.revision.saturating_add(1);
        TaskHistoryPage {
            events,
            next: page.next_cursor.as_ref().map(|cursor| TaskHistoryCursor {
                turns: Some(cursor.clone()),
                ..TaskHistoryCursor::default()
            }),
            revision: thread.revision,
            owns_extent: (cursor.is_some()
                || !thread.turns.values().any(|turn| turn.mixed_sources))
                && page
                    .turns
                    .iter()
                    .all(|turn| !thread.turns[&turn.id].mixed_sources),
        }
    }

    #[cfg(test)]
    pub(super) fn accept_history(
        &self,
        thread_id: &str,
        turn: &Turn,
        incoming: Vec<TaskEventRecord>,
        base_revision: u64,
        latest: bool,
    ) -> Vec<TaskEventRecord> {
        self.state
            .lock()
            .unwrap()
            .entry(thread_id.to_string())
            .or_default()
            .accept_history(turn, incoming, base_revision, latest)
    }

    pub(super) fn begin_history_request(&self, thread_id: &str) -> u64 {
        let mut state = self.state.lock().expect("conversation cache lock");
        let thread = state.entry(thread_id.to_string()).or_default();
        thread.history_request = thread.history_request.saturating_add(1);
        thread.history_request
    }

    /// A missing turn stops this window. Its continuation reloads that exact
    /// provider page; retained neighbors do not authorize skipping the gap.
    pub(super) fn cached_page(
        &self,
        thread_id: &str,
        cursor: &TaskHistoryCursor,
    ) -> Option<TaskHistoryPage> {
        let mut state = self.state.lock().expect("conversation cache lock");
        let thread = state.get_mut(thread_id)?;
        let Some(page) = thread.pages.get(&cursor.turns) else {
            if cursor != &TaskHistoryCursor::default() {
                return None;
            }
            let mut events = thread
                .turns
                .values()
                .flat_map(|turn| turn.events.iter())
                .chain(thread.supplemental.iter())
                .map(|entry| entry.event.clone())
                .collect::<Vec<_>>();
            sort_task_events(&mut events);
            thread.revision = thread.revision.saturating_add(1);
            return Some(TaskHistoryPage {
                events,
                next: None,
                revision: thread.revision,
                owns_extent: false,
            });
        };
        let start = match cursor.turn_id.as_ref() {
            Some(id) => page.ids.iter().position(|candidate| candidate == id)?,
            None => 0,
        };
        let mut events = Vec::new();
        // A latest snapshot can cover records outside this provider page. An
        // empty read after a gap does not prove that retained evidence vanished.
        let mut owns_extent = cursor != &TaskHistoryCursor::default()
            || !thread.turns.values().any(|turn| turn.mixed_sources);
        let mut next = page.next.as_ref().map(|cursor| TaskHistoryCursor {
            turns: Some(cursor.clone()),
            ..TaskHistoryCursor::default()
        });
        for (offset, id) in page.ids[start..].iter().enumerate() {
            let Some(turn) = thread.turns.get_mut(id) else {
                if offset == 0 {
                    return None;
                }
                next = Some(TaskHistoryCursor {
                    turns: cursor.turns.clone(),
                    turn_id: Some(id.clone()),
                    before: None,
                    item_id: None,
                });
                break;
            };
            thread.access = thread.access.saturating_add(1);
            turn.access = thread.access;
            owns_extent &=
                !turn.mixed_sources && (turn.complete_live || turn.history_revision.is_some());
            events.extend(turn.events.iter().map(|entry| entry.event.clone()));
        }
        if cursor.turns.is_none() && cursor.before.is_none() && cursor.turn_id.is_none() {
            events.extend(thread.supplemental.iter().map(|entry| entry.event.clone()));
        }
        sort_task_events(&mut events);
        thread.revision = thread.revision.saturating_add(1);
        Some(TaskHistoryPage {
            events,
            next,
            revision: thread.revision,
            owns_extent,
        })
    }

    pub(super) fn finish_history_request(
        &self,
        thread_id: &str,
        request: u64,
        turn_id: Option<&str>,
    ) {
        let mut state = self.state.lock().expect("conversation cache lock");
        if let Some(thread) = state.get_mut(thread_id) {
            if thread.history_request == request {
                thread.historical = turn_id.map(str::to_string);
            }
            thread.evict();
        }
    }

    pub(super) fn trim(&self, thread_id: &str) {
        if let Some(thread) = self
            .state
            .lock()
            .expect("conversation cache lock")
            .get_mut(thread_id)
        {
            thread.evict();
        }
    }

    #[cfg(test)]
    pub(super) fn snapshot_for_thread(&self, thread_id: &str) -> TaskEventSnapshot {
        let mut state = self.state.lock().expect("conversation cache lock");
        let thread = state.entry(thread_id.to_string()).or_default();
        thread.revision = thread.revision.saturating_add(1);
        TaskEventSnapshot {
            revision: thread.revision,
            observations: thread
                .turns
                .values()
                .flat_map(|turn| turn.events.iter())
                .chain(thread.supplemental.iter())
                .cloned()
                .collect(),
            fully_observed_turns: thread
                .turns
                .iter()
                .filter(|(_, turn)| turn.complete_live)
                .map(|(id, _)| id.clone())
                .collect(),
        }
    }

    pub(super) fn invalidate_continuity(&self, thread_id: &str) {
        let mut state = self.state.lock().expect("conversation cache lock");
        if let Some(thread) = state.get_mut(thread_id) {
            for turn in thread.turns.values_mut() {
                turn.complete_live = false;
                turn.history_revision = None;
                turn.mixed_sources = true;
            }
            thread.latest = None;
            thread.latest_revision = 0;
            thread.historical = None;
            thread.pages.clear();
            thread.history_request = thread.history_request.saturating_add(1);
            thread.revision = thread.revision.saturating_add(1);
        }
    }

    pub(super) fn remove_thread(&self, thread_id: &str) {
        self.state
            .lock()
            .expect("conversation cache lock")
            .remove(thread_id);
    }

    #[cfg(test)]
    pub(super) fn for_thread(&self, thread_id: &str) -> Vec<TaskEventRecord> {
        let mut events = self
            .snapshot_for_thread(thread_id)
            .observations
            .into_iter()
            .map(|entry| entry.event)
            .collect::<Vec<_>>();
        sort_task_events(&mut events);
        events
    }

    #[cfg(test)]
    pub(super) fn fully_observed_turns(&self, thread_id: &str) -> HashSet<String> {
        self.snapshot_for_thread(thread_id).fully_observed_turns
    }

    #[cfg(test)]
    pub(super) fn observe_provider_lifecycle(&self, events: &[TaskEventRecord]) {
        for event in events {
            self.record_provider_lifecycle(event.clone());
        }
    }

    #[cfg(test)]
    pub(super) fn record_provider_lifecycle(&self, event: TaskEventRecord) -> TaskEventRecord {
        self.record_observation(event, TaskEventObservationSource::ProviderLifecycle, None)
            .event
    }

    #[cfg(test)]
    pub(super) fn record_accepted(&self, event: TaskEventRecord) -> TaskEventRecord {
        self.record_observation(event, TaskEventObservationSource::AcceptedSubmission, None)
            .event
    }

    #[cfg(test)]
    pub(super) fn record_local(&self, event: TaskEventRecord) -> TaskEventRecord {
        self.record_observation(event, TaskEventObservationSource::LocalProjection, None)
            .event
    }
}

impl CachedTurn {
    fn new(anchor_ms: u64, access: u64) -> Self {
        Self {
            events: Vec::new(),
            anchor_ms,
            complete_live: false,
            mixed_sources: false,
            terminal: false,
            history_revision: None,
            access,
        }
    }

    fn item_count(&self) -> usize {
        self.events
            .iter()
            .filter(|entry| {
                !matches!(
                    entry.event.event_type.as_str(),
                    "turn_started" | "turn_completed"
                ) && entry.source != TaskEventObservationSource::LocalProjection
            })
            .count()
    }
}

impl ThreadEvents {
    fn accept_history(
        &mut self,
        turn: &Turn,
        incoming: Vec<TaskEventRecord>,
        base_revision: u64,
        latest: bool,
    ) -> Vec<TaskEventRecord> {
        self.access = self.access.saturating_add(1);
        let anchor = turn
            .started_at_ms
            .or(turn.completed_at_ms)
            .or_else(|| incoming.first().map(|event| event.position.anchor_ms))
            .unwrap_or(0);
        let cached = self
            .turns
            .entry(turn.id.clone())
            .or_insert_with(|| CachedTurn::new(anchor, self.access));
        cached.access = self.access;
        if latest && self.latest_revision <= base_revision {
            self.latest = Some(turn.id.clone());
            self.latest_revision = base_revision;
        }
        if cached
            .history_revision
            .is_none_or(|revision| revision <= base_revision)
        {
            cached.terminal |= turn.status != TurnStatus::InProgress;
            if !cached.complete_live {
                if cached.history_revision.is_none() {
                    cached.anchor_ms = anchor;
                }
                let previous = std::mem::take(&mut cached.events);
                let mut retained = Vec::<TaskEventObservation>::new();
                for mut event in incoming {
                    if event.event_type != "turn_completed" {
                        event.position.anchor_ms = cached.anchor_ms;
                    }
                    let mut source = TaskEventObservationSource::ProviderHistory;
                    let mut session_revision = Some(base_revision);
                    let prior = previous.iter().find(|entry| entry.event.id == event.id);
                    if let Some(prior) = prior {
                        let live_is_newer = prior.source
                            == TaskEventObservationSource::ProviderLifecycle
                            && prior
                                .session_revision
                                .is_some_and(|revision| revision > base_revision)
                            && !provider_lifecycle_regresses(&event, &prior.event);
                        let position = if cached.history_revision.is_some() {
                            prior.event.position
                        } else {
                            event.position
                        };
                        event = if live_is_newer {
                            source = prior.source;
                            session_revision = prior.session_revision;
                            let kind = event.event_type.clone();
                            let mut merged =
                                project_primary_record(prior.event.clone(), event, position);
                            merged.event_type = kind;
                            merged
                        } else {
                            project_primary_record(event, prior.event.clone(), position)
                        };
                    }
                    let observation = TaskEventObservation {
                        event,
                        publication_revision: self.revision,
                        session_revision,
                        source,
                    };
                    if let Some(existing) = retained
                        .iter_mut()
                        .find(|entry| entry.event.id == observation.event.id)
                    {
                        *existing = observation;
                    } else {
                        retained.push(observation);
                    }
                }
                // A read owns its own history IDs. Unmatched live and
                // accepted IDs may come from a different legacy projection;
                // absence is not evidence that the displayed item vanished.
                // A Caffold-owned projection is never listed by a provider,
                // so it cannot leave membership unresolved.
                let mut unresolved = false;
                for observation in previous {
                    if observation.source == TaskEventObservationSource::ProviderHistory
                        || retained
                            .iter()
                            .any(|entry| entry.event.id == observation.event.id)
                    {
                        continue;
                    }
                    unresolved |= observation.source != TaskEventObservationSource::LocalProjection;
                    retained.push(observation);
                }
                cached.mixed_sources = unresolved;
                cached.events = retained;
            }
            cached.history_revision = Some(base_revision);
        }
        let mut events = cached
            .events
            .iter()
            .map(|entry| entry.event.clone())
            .collect::<Vec<_>>();
        sort_task_events(&mut events);
        events
    }

    fn remember_page(&mut self, cursor: Option<&str>, page: &TurnPage, base_revision: u64) {
        let key = cursor.map(str::to_string);
        if self
            .pages
            .get(&key)
            .is_some_and(|previous| previous.base_revision > base_revision)
        {
            return;
        }
        let mut ids = page
            .turns
            .iter()
            .map(|turn| turn.id.clone())
            .collect::<Vec<_>>();
        if cursor.is_none()
            && self.latest_revision > base_revision
            && let Some(previous) = self.pages.get(&None)
        {
            let mut newer = previous
                .ids
                .iter()
                .filter(|id| !ids.contains(id))
                .cloned()
                .collect::<Vec<_>>();
            newer.append(&mut ids);
            ids = newer;
        }
        self.pages.insert(
            key,
            PageTurns {
                ids,
                next: page.next_cursor.clone(),
                base_revision,
            },
        );
    }

    fn evict(&mut self) {
        let protected =
            |id: &str| self.latest.as_deref() == Some(id) || self.historical.as_deref() == Some(id);
        let mut count = self
            .turns
            .values()
            .map(CachedTurn::item_count)
            .sum::<usize>();
        let mut candidates = self
            .turns
            .iter()
            .filter(|(id, turn)| turn.terminal && !protected(id))
            .map(|(id, turn)| (turn.access, id.clone(), turn.item_count()))
            .collect::<Vec<_>>();
        candidates.sort();
        for (_, id, items) in candidates {
            if count > RETAINED_ITEM_LIMIT || items == 0 {
                self.turns.remove(&id);
                if items == 0 {
                    for page in self.pages.values_mut() {
                        page.ids.retain(|candidate| candidate != &id);
                    }
                }
                count -= items;
            }
        }
        self.pages.retain(|cursor, page| {
            cursor.is_none() || page.ids.iter().any(|id| self.turns.contains_key(id))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{TurnOrigin, TurnState};
    use crate::app::tasks::events::{TaskEvents, task_event_record, turn_started_event};
    use serde_json::json;

    fn item(turn_id: &str, id: &str, at: u64) -> TaskEventRecord {
        task_event_record(
            "thread",
            &format!("{turn_id}:{id}"),
            "agent_message",
            id,
            Some(json!({"turnId": turn_id, "itemId": id, "text": id})),
            at,
        )
    }

    fn start(id: &str, at: u64) -> TaskEventRecord {
        turn_started_event(
            "thread",
            &TurnState {
                id: id.into(),
                origin: TurnOrigin::Unknown,
                status: TurnStatus::InProgress,
                started_at_ms: Some(at),
                completed_at_ms: None,
            },
            at,
        )
    }

    fn history(id: &str, at: u64) -> Turn {
        Turn {
            id: id.into(),
            origin: TurnOrigin::Unknown,
            status: TurnStatus::Completed,
            started_at_ms: Some(at),
            completed_at_ms: Some(at + 1),
            items: vec![],
        }
    }

    #[test]
    fn continuous_long_turn_keeps_every_item_and_its_position_through_history() {
        let cache = TurnEventCache::default();
        cache.record_observation(
            start("long", 100),
            TaskEventObservationSource::ProviderLifecycle,
            Some(1),
        );
        let mut positions = Vec::new();
        for i in 0..600 {
            positions.push(
                cache
                    .record_observation(
                        item("long", &i.to_string(), 101 + i),
                        TaskEventObservationSource::ProviderLifecycle,
                        Some(i + 2),
                    )
                    .event
                    .position,
            );
        }
        let read = cache.accept_history(
            "thread",
            &history("long", 100),
            vec![item("long", "item-1", 100)],
            700,
            true,
        );
        assert_eq!(read.len(), 601);
        assert_eq!(
            read[1..].iter().map(|e| e.position).collect::<Vec<_>>(),
            positions
        );
        assert!(!read.iter().any(|e| e.id == "thread:long:item-1"));
    }

    #[test]
    fn a_late_initial_read_cannot_reprotect_an_older_turn() {
        let cache = TurnEventCache::default();
        cache.record_observation(
            start("new", 500),
            TaskEventObservationSource::ProviderLifecycle,
            Some(10),
        );
        cache.accept_history(
            "thread",
            &history("old", 100),
            vec![item("old", "a", 100)],
            5,
            true,
        );
        assert_eq!(
            cache.state.lock().unwrap()["thread"].latest.as_deref(),
            Some("new")
        );
    }

    #[test]
    fn partial_attachment_keeps_unmatched_live_evidence_without_guessing_ids() {
        let cache = TurnEventCache::default();
        cache.record_observation(
            item("partial", "native", 500),
            TaskEventObservationSource::ProviderLifecycle,
            Some(1),
        );
        let events = cache.accept_history(
            "thread",
            &history("partial", 100),
            vec![item("partial", "item-1", 100)],
            5,
            true,
        );
        assert_eq!(events.len(), 2);
        assert!(events.iter().any(|e| e.id == "thread:partial:native"));
        assert!(events.iter().any(|e| e.id == "thread:partial:item-1"));
    }

    #[test]
    fn an_empty_read_after_a_gap_cannot_erase_retained_evidence() {
        let cache = TurnEventCache::default();
        cache.record_observation(
            item("partial", "native", 500),
            TaskEventObservationSource::ProviderLifecycle,
            Some(1),
        );
        cache.invalidate_continuity("thread");
        let empty = TurnPage {
            turns: vec![],
            next_cursor: None,
            backwards_cursor: None,
        };
        let accepted = cache.accept_page("thread", &empty, HashMap::new(), 2, None);
        assert!(!accepted.owns_extent);
        let read = cache
            .cached_page("thread", &TaskHistoryCursor::default())
            .unwrap();
        assert!(!read.owns_extent);
        assert_eq!(cache.for_thread("thread").len(), 1);

        let fresh = cache.accept_page("new-thread", &empty, HashMap::new(), 0, None);
        assert!(fresh.owns_extent);
    }

    #[test]
    fn latest_turns_of_more_than_128_tasks_are_independently_retained() {
        let events = TaskEvents::default();
        for i in 0..140 {
            let mut event = start("turn", 100);
            event.thread_id = format!("thread-{i}");
            events.publish_provider_lifecycle(event, 1);
        }
        for i in 0..140 {
            assert_eq!(events.for_thread(&format!("thread-{i}")).len(), 1);
        }
    }
    #[test]
    fn item_budget_evicts_whole_turns_while_two_large_protected_turns_survive() {
        let cache = TurnEventCache::default();
        for (id, count, latest) in [
            ("latest", 800, true),
            ("past", 700, false),
            ("other", 20, false),
        ] {
            let records = (0..count).map(|i| item(id, &i.to_string(), 100)).collect();
            cache.accept_history("thread", &history(id, 100), records, 1, latest);
        }
        let request = cache.begin_history_request("thread");
        cache.finish_history_request("thread", request, Some("past"));
        let state = cache.state.lock().unwrap();
        let thread = &state["thread"];
        assert_eq!(thread.turns.len(), 2);
        assert_eq!(thread.turns["latest"].item_count(), 800);
        assert_eq!(thread.turns["past"].item_count(), 700);
        assert!(!thread.turns.contains_key("other"));
    }

    #[test]
    fn the_300_item_budget_uses_whole_turn_lru_and_updates_do_not_add_items() {
        let cache = TurnEventCache::default();
        for (id, count, at, latest) in [
            ("old", 100, 100, false),
            ("warm", 100, 200, false),
            ("latest", 100, 300, true),
        ] {
            let records = (0..count).map(|i| item(id, &i.to_string(), at)).collect();
            cache.accept_history("thread", &history(id, at), records, 1, latest);
        }
        cache.trim("thread");
        assert_eq!(cache.state.lock().unwrap()["thread"].turns.len(), 3);
        for _ in 0..5 {
            cache.record_provider_lifecycle(item("warm", "0", 200));
        }
        assert_eq!(
            cache.state.lock().unwrap()["thread"].turns["warm"].item_count(),
            100
        );
        cache.record_provider_lifecycle(item("latest", "100", 300));
        let state = cache.state.lock().unwrap();
        assert!(!state["thread"].turns.contains_key("old"));
        assert_eq!(state["thread"].turns["warm"].item_count(), 100);
        assert_eq!(state["thread"].turns["latest"].item_count(), 101);
    }

    #[test]
    fn a_late_history_success_does_not_repin_after_a_newer_request_failed() {
        let cache = TurnEventCache::default();
        for id in ["previous", "late", "latest"] {
            cache.accept_history(
                "thread",
                &history(id, 100),
                vec![item(id, "a", 100)],
                1,
                id == "latest",
            );
        }
        let first = cache.begin_history_request("thread");
        cache.finish_history_request("thread", first, Some("previous"));
        let late = cache.begin_history_request("thread");
        let _failed = cache.begin_history_request("thread");
        cache.finish_history_request("thread", late, Some("late"));
        assert_eq!(
            cache.state.lock().unwrap()["thread"].historical.as_deref(),
            Some("previous")
        );
    }

    #[test]
    fn empty_unprotected_turns_leave_no_repeated_missing_page() {
        let cache = TurnEventCache::default();
        let page = TurnPage {
            turns: vec![history("latest", 300), history("empty", 100)],
            ..TurnPage::default()
        };
        let response = cache.accept_page("thread", &page, HashMap::new(), 1, None);
        assert!(response.next.is_none());
        cache.trim("thread");
        let state = cache.state.lock().unwrap();
        assert_eq!(state["thread"].turns.len(), 1);
        assert_eq!(state["thread"].pages[&None].ids, ["latest"]);
    }
    #[test]
    #[ignore = "allocates large synthetic payloads for the retention audit"]
    fn large_payload_retention_reports_items_bytes_and_process_memory_separately() {
        fn rss_kib() -> String {
            String::from_utf8(
                std::process::Command::new("ps")
                    .args(["-o", "rss=", "-p", &std::process::id().to_string()])
                    .output()
                    .unwrap()
                    .stdout,
            )
            .unwrap()
            .trim()
            .to_string()
        }
        let before = rss_kib();
        let started = std::time::Instant::now();
        let cache = TurnEventCache::default();
        for (id, count, latest) in [("latest", 800, true), ("past", 700, false)] {
            let records = (0..count)
                .map(|i| {
                    let mut event = item(id, &i.to_string(), 100);
                    event.payload.as_mut().unwrap()["text"] = json!("x".repeat(64 * 1024));
                    event
                })
                .collect();
            cache.accept_history("thread", &history(id, 100), records, 1, latest);
        }
        let request = cache.begin_history_request("thread");
        cache.finish_history_request("thread", request, Some("past"));
        let state = cache.state.lock().unwrap();
        let turns = &state["thread"].turns;
        let items = turns.values().map(CachedTurn::item_count).sum::<usize>();
        let payload_bytes = turns
            .values()
            .flat_map(|turn| &turn.events)
            .map(|entry| {
                entry.event.payload.as_ref().unwrap()["text"]
                    .as_str()
                    .unwrap()
                    .len()
            })
            .sum::<usize>();
        assert_eq!(
            (turns.len(), items, payload_bytes),
            (2, 1500, 1500 * 64 * 1024)
        );
        eprintln!(
            "retention audit: turns={}, items={items}, payload_bytes={payload_bytes}, rss_before_kib={before}, rss_after_kib={}, elapsed_ms={}",
            turns.len(),
            rss_kib(),
            started.elapsed().as_millis()
        );
    }

    fn page_of(turns: Vec<Turn>) -> TurnPage {
        TurnPage {
            turns,
            next_cursor: None,
            backwards_cursor: None,
        }
    }

    fn approval(turn_id: &str, id: &str, at: u64) -> TaskEventRecord {
        task_event_record(
            "thread",
            &format!("{turn_id}:{id}"),
            "approval_requested",
            id,
            Some(json!({"turnId": turn_id, "approvalId": id})),
            at,
        )
    }

    #[test]
    fn a_full_read_after_a_gap_owns_the_extent_again() {
        let cache = TurnEventCache::default();
        let page = page_of(vec![history("old", 100)]);
        let listed = HashMap::from([("old".to_string(), vec![item("old", "a", 100)])]);
        assert!(
            cache
                .accept_page("thread", &page, listed.clone(), 1, None)
                .owns_extent
        );

        cache.invalidate_continuity("thread");
        assert!(
            !cache
                .cached_page("thread", &TaskHistoryCursor::default())
                .unwrap()
                .owns_extent
        );

        assert!(
            cache
                .accept_page("thread", &page, listed, 2, None)
                .owns_extent
        );
        let read = cache
            .cached_page("thread", &TaskHistoryCursor::default())
            .unwrap();
        assert!(read.owns_extent);
        assert_eq!(read.events.len(), 1);
    }

    #[test]
    fn live_reports_joining_a_turn_read_from_history_keep_its_membership_until_a_read_leaves_one_unlisted()
     {
        let cache = TurnEventCache::default();
        let running = || Turn {
            status: TurnStatus::InProgress,
            completed_at_ms: None,
            ..history("attached", 100)
        };
        let listed = HashMap::from([("attached".to_string(), vec![item("attached", "a", 100)])]);
        assert!(
            cache
                .accept_page("thread", &page_of(vec![running()]), listed.clone(), 1, None)
                .owns_extent
        );
        cache.record_observation(
            item("attached", "live", 101),
            TaskEventObservationSource::ProviderLifecycle,
            Some(2),
        );
        let inside = TaskHistoryCursor {
            turn_id: Some("attached".into()),
            ..TaskHistoryCursor::default()
        };
        assert!(
            cache
                .cached_page("thread", &TaskHistoryCursor::default())
                .unwrap()
                .owns_extent
        );
        let read = cache.cached_page("thread", &inside).unwrap();
        assert!(read.owns_extent);
        assert_eq!(read.events.len(), 2);

        assert!(
            !cache
                .accept_page("thread", &page_of(vec![running()]), listed, 3, None)
                .owns_extent,
            "a read that does not list the live report leaves membership unresolved"
        );
        assert!(!cache.cached_page("thread", &inside).unwrap().owns_extent);

        let completed = HashMap::from([(
            "attached".to_string(),
            vec![item("attached", "a", 100), item("attached", "live", 101)],
        )]);
        assert!(
            cache
                .accept_page(
                    "thread",
                    &page_of(vec![history("attached", 100)]),
                    completed,
                    4,
                    None
                )
                .owns_extent
        );
        let read = cache.cached_page("thread", &inside).unwrap();
        assert!(read.owns_extent);
        assert_eq!(read.events.len(), 2);
    }

    #[test]
    fn a_caffold_owned_approval_record_does_not_leave_a_re_read_turn_unresolved() {
        let cache = TurnEventCache::default();
        let page = page_of(vec![history("asked", 100)]);
        let listed = HashMap::from([("asked".to_string(), vec![item("asked", "a", 100)])]);
        cache.accept_page("thread", &page, listed.clone(), 1, None);
        cache.record_observation(
            approval("asked", "approval-1", 101),
            TaskEventObservationSource::LocalProjection,
            None,
        );
        cache.invalidate_continuity("thread");

        assert!(
            cache
                .accept_page("thread", &page, listed, 2, None)
                .owns_extent
        );
        let read = cache
            .cached_page("thread", &TaskHistoryCursor::default())
            .unwrap();
        assert!(read.owns_extent);
        assert!(
            read.events
                .iter()
                .any(|event| event.event_type == "approval_requested"),
            "the approval record stays readable"
        );
    }

    #[test]
    fn a_read_that_leaves_live_evidence_unmatched_keeps_the_turn_unresolved() {
        let cache = TurnEventCache::default();
        cache.record_observation(
            item("partial", "native", 101),
            TaskEventObservationSource::ProviderLifecycle,
            Some(1),
        );
        cache.invalidate_continuity("thread");
        let listed = HashMap::from([(
            "partial".to_string(),
            vec![item("partial", "history-only", 100)],
        )]);
        assert!(
            !cache
                .accept_page(
                    "thread",
                    &page_of(vec![history("partial", 100)]),
                    listed,
                    2,
                    None
                )
                .owns_extent
        );
        assert!(
            !cache
                .cached_page("thread", &TaskHistoryCursor::default())
                .unwrap()
                .owns_extent
        );
    }
}
