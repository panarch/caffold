use super::*;

pub(super) async fn codex_status(State(state): State<TaskState>) -> Json<CodexStatusPayload> {
    let (status, process_generation, process_connected) =
        state.codex_runtime.status_with_diagnostics().await;
    let diagnostics = CodexRuntimeDiagnostics {
        process_generation,
        process_connected,
        thread_sessions: state.codex_sessions.diagnostics().await,
        usage: state.codex_runtime.usage_diagnostics(),
    };
    Json(CodexStatusPayload {
        status,
        diagnostics,
    })
}

pub(super) async fn codex_restart(
    State(state): State<TaskState>,
) -> Result<Json<CodexDaemonInfo>, ApiError> {
    state
        .codex_runtime
        .restart_daemon()
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) fn normalize_approval_decision(decision: &str) -> Result<ApprovalDecision, ApiError> {
    match decision {
        "allow" => Ok(ApprovalDecision::Allow),
        "allowAlways" => Ok(ApprovalDecision::AllowAlways),
        "deny" => Ok(ApprovalDecision::Deny),
        "denyAndStop" => Ok(ApprovalDecision::DenyAndStop),
        _ => Err(ApiError::BadRequest {
            code: "invalid_approval_decision",
            message: "approval decision is not supported".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_browser_answers_with_one_of_caffolds_four_decisions() {
        let decisions = [
            ("allow", ApprovalDecision::Allow),
            ("allowAlways", ApprovalDecision::AllowAlways),
            ("deny", ApprovalDecision::Deny),
            ("denyAndStop", ApprovalDecision::DenyAndStop),
        ];

        for (sent, expected) in decisions {
            assert_eq!(normalize_approval_decision(sent).unwrap(), expected);
        }
    }

    #[test]
    fn a_decision_caffold_does_not_offer_is_refused() {
        // A card from an older page, or an agent's own vocabulary leaking
        // through, is a bad request rather than something to guess at.
        for sent in ["accept", "acceptForSession", "decline", "cancel", ""] {
            assert!(matches!(
                normalize_approval_decision(sent),
                Err(ApiError::BadRequest {
                    code: "invalid_approval_decision",
                    ..
                })
            ));
        }
    }
}
