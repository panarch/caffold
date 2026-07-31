mod detail;
mod events;
mod projection;
mod runtime;
mod sync;

pub(super) use events::{TaskEventRecord, TaskEvents, accepted_user_message_event, now_ms};
pub(super) use projection::{
    TaskRecord, resolve_task_cwds, task_activity_ms, thread_list_response_with_resolved,
};
pub(super) use runtime::{ApprovalResolveError, CodexConnection, CodexRuntime};
pub(super) use sync::TaskSync;

#[cfg(test)]
mod tests;
pub(super) use detail::{DetailContext, DetailFrameStream, TaskDetailResponse, TaskDetailSync};
