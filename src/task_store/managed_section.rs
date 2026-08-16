use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        data::Value,
        executor::Payload,
        query_builder::{Execute, ExprNode, col, table, text, value as glue_value},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, SelectResultExt},
};

#[cfg(test)]
use gluesql::core::data::Schema;

use super::{Result, TaskStoreError};

pub(super) const TABLE_NAME: &str = "managed_sections";
const POSITION_STEP: i64 = 1024;

const COLUMN_DEFINITIONS: &[&str] = &[
    "section_id TEXT PRIMARY KEY",
    "logical_path TEXT",
    "position INTEGER",
];

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
pub(crate) struct ManagedSection {
    pub section_id: String,
    pub logical_path: String,
    pub position: i64,
}

pub(super) fn create_table<S>(glue: &mut Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let mut query = table(TABLE_NAME).create_table_if_not_exists();
    for definition in COLUMN_DEFINITIONS {
        query = query.add_column(*definition);
    }
    query.execute(glue)?;
    Ok(())
}

#[cfg(test)]
pub(super) fn validate_table<S>(glue: &Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let actual = glue
        .storage
        .fetch_schema(TABLE_NAME)?
        .ok_or(TaskStoreError::IncompleteSchema)?;
    let expected = Schema::from_ddl(&format!(
        "CREATE TABLE {TABLE_NAME} ({});",
        COLUMN_DEFINITIONS.join(", ")
    ))?;
    if actual.column_defs != expected.column_defs {
        return Err(TaskStoreError::InvalidSchemaTable(TABLE_NAME.to_string()));
    }
    Ok(())
}

pub(super) fn get<S>(glue: &mut Glue<S>, section_id: &str) -> Result<Option<ManagedSection>>
where
    S: GStore + GStoreMut + Planner,
{
    let rows = table(TABLE_NAME)
        .select()
        .filter(col("section_id").eq(text(section_id.to_owned())))
        .project(columns())
        .limit(1)
        .execute(glue)
        .rows_as::<ManagedSection>()?;
    Ok(rows.into_iter().next())
}

pub(super) fn list<S>(glue: &mut Glue<S>) -> Result<Vec<ManagedSection>>
where
    S: GStore + GStoreMut + Planner,
{
    let mut sections = table(TABLE_NAME)
        .select()
        .project(columns())
        .execute(glue)
        .rows_as::<ManagedSection>()?;
    sections.sort_by(|left, right| {
        left.position
            .cmp(&right.position)
            .then_with(|| left.section_id.cmp(&right.section_id))
    });
    Ok(sections)
}

pub(super) fn insert_at_top<S>(
    glue: &mut Glue<S>,
    section_id: &str,
    logical_path: &str,
) -> Result<ManagedSection>
where
    S: GStore + GStoreMut + Planner,
{
    let mut sections = list(glue)?;
    let position = sections
        .first()
        .and_then(|section| section.position.checked_sub(POSITION_STEP))
        .unwrap_or(0);
    let section = ManagedSection {
        section_id: section_id.to_string(),
        logical_path: logical_path.to_string(),
        position,
    };
    if sections.is_empty() || position < sections[0].position {
        upsert(glue, &section)?;
        return Ok(section);
    }

    upsert(glue, &section)?;
    sections.insert(0, section);
    rebalance(glue, &mut sections)?;
    Ok(sections.remove(0))
}

pub(super) fn move_before<S>(
    glue: &mut Glue<S>,
    section_id: &str,
    before_section_id: Option<&str>,
) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    if before_section_id == Some(section_id) {
        return Err(TaskStoreError::SectionReorderConflict(
            "a Section cannot be placed before itself",
        ));
    }
    let original = list(glue)?;
    let Some(target_index) = original
        .iter()
        .position(|section| section.section_id == section_id)
    else {
        return Err(TaskStoreError::SectionReorderUnavailable(
            "moved Section is not managed",
        ));
    };
    if let Some(anchor_id) = before_section_id
        && !original
            .iter()
            .any(|section| section.section_id == anchor_id)
    {
        return Err(TaskStoreError::SectionReorderConflict(
            "the requested anchor is missing",
        ));
    }
    let original_ids = original
        .iter()
        .map(|section| section.section_id.as_str())
        .collect::<Vec<_>>();
    let mut final_order = original.clone();
    let target = final_order.remove(target_index);
    let destination = match before_section_id {
        Some(anchor_id) => final_order
            .iter()
            .position(|section| section.section_id == anchor_id)
            .ok_or(TaskStoreError::SectionReorderConflict(
                "the requested anchor changed before the move committed",
            ))?,
        None => final_order.len(),
    };
    final_order.insert(destination, target);
    if final_order
        .iter()
        .map(|section| section.section_id.as_str())
        .eq(original_ids)
    {
        return Ok(false);
    }

    let moved_index = final_order
        .iter()
        .position(|section| section.section_id == section_id)
        .ok_or(TaskStoreError::UnexpectedPayload)?;
    let previous = moved_index
        .checked_sub(1)
        .map(|index| final_order[index].position);
    let next = final_order
        .get(moved_index + 1)
        .map(|section| section.position);
    if let Some(position) = sparse_position_between(previous, next) {
        final_order[moved_index].position = position;
        update_position(glue, &final_order[moved_index])?;
    } else {
        rebalance(glue, &mut final_order)?;
    }
    Ok(true)
}

pub(super) fn upsert<S>(glue: &mut Glue<S>, section: &ManagedSection) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    validate(section)?;
    if get(glue, &section.section_id)?.is_some() {
        let payload = table(TABLE_NAME)
            .update()
            .filter(col("section_id").eq(text(section.section_id.clone())))
            .set("logical_path", text(section.logical_path.clone()))
            .execute(glue)?;
        match payload {
            Payload::Update(1) => Ok(()),
            _ => Err(TaskStoreError::UnexpectedPayload),
        }
    } else {
        table(TABLE_NAME)
            .insert()
            .values_from(std::slice::from_ref(section))?
            .execute(glue)?;
        Ok(())
    }
}

#[cfg(test)]
pub(super) fn delete_all<S>(glue: &mut Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    match table(TABLE_NAME).delete().execute(glue)? {
        Payload::Delete(_) => Ok(()),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

fn columns() -> Vec<ExprNode<'static>> {
    ManagedSection::glue_columns()
        .iter()
        .map(|column| col(*column))
        .collect()
}

fn validate(section: &ManagedSection) -> Result<()> {
    if section.section_id.trim().is_empty() {
        return Err(TaskStoreError::InvalidRow("section_id"));
    }
    Ok(())
}

fn update_position<S>(glue: &mut Glue<S>, section: &ManagedSection) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    match table(TABLE_NAME)
        .update()
        .filter(col("section_id").eq(text(section.section_id.clone())))
        .set("position", glue_value(Value::I64(section.position)))
        .execute(glue)?
    {
        Payload::Update(1) => Ok(()),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

fn sparse_position_between(previous: Option<i64>, next: Option<i64>) -> Option<i64> {
    match (previous, next) {
        (None, None) => Some(0),
        (None, Some(next)) => next.checked_sub(POSITION_STEP),
        (Some(previous), None) => previous.checked_add(POSITION_STEP),
        (Some(previous), Some(next)) => {
            let gap = i128::from(next) - i128::from(previous);
            (gap > 1)
                .then(|| i128::from(previous) + gap / 2)
                .and_then(|position| i64::try_from(position).ok())
        }
    }
}

fn rebalance<S>(glue: &mut Glue<S>, sections: &mut [ManagedSection]) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    for (index, section) in sections.iter_mut().enumerate() {
        let index =
            i64::try_from(index).map_err(|_| TaskStoreError::InvalidRow("section_position"))?;
        section.position = index
            .checked_mul(POSITION_STEP)
            .ok_or(TaskStoreError::InvalidRow("section_position"))?;
        update_position(glue, section)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use gluesql::prelude::MemoryStorage;

    use super::*;

    fn memory() -> Glue<MemoryStorage> {
        let mut glue = Glue::new(MemoryStorage::default());
        create_table(&mut glue).unwrap();
        glue
    }

    #[test]
    fn owns_schema_and_upserts_sections() {
        let mut glue = memory();
        validate_table(&glue).unwrap();
        let mut section = ManagedSection {
            section_id: "section-1".to_string(),
            logical_path: "Workspace/rust/codger".to_string(),
            position: 1024,
        };
        upsert(&mut glue, &section).unwrap();
        section.logical_path = "Workspace/rust/caffold".to_string();
        upsert(&mut glue, &section).unwrap();
        assert_eq!(list(&mut glue).unwrap(), vec![section]);
        upsert(
            &mut glue,
            &ManagedSection {
                section_id: "root-section".to_string(),
                logical_path: String::new(),
                position: 0,
            },
        )
        .unwrap();
        delete_all(&mut glue).unwrap();
        assert!(list(&mut glue).unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_sections() {
        let mut glue = memory();
        assert!(matches!(
            upsert(
                &mut glue,
                &ManagedSection {
                    section_id: "".to_string(),
                    logical_path: "path".to_string(),
                    position: 0,
                },
            ),
            Err(TaskStoreError::InvalidRow("section_id"))
        ));
    }

    #[test]
    fn inserts_at_top_and_moves_with_sparse_ranks() {
        let mut glue = memory();
        for (id, position) in [("a", 0), ("b", 1024), ("c", 2048)] {
            upsert(
                &mut glue,
                &ManagedSection {
                    section_id: id.to_string(),
                    logical_path: id.to_string(),
                    position,
                },
            )
            .unwrap();
        }

        assert!(move_before(&mut glue, "c", Some("b")).unwrap());
        assert_eq!(
            list(&mut glue)
                .unwrap()
                .iter()
                .map(|section| (section.section_id.as_str(), section.position))
                .collect::<Vec<_>>(),
            [("a", 0), ("c", 512), ("b", 1024)]
        );
        assert!(!move_before(&mut glue, "c", Some("b")).unwrap());
        assert!(move_before(&mut glue, "a", None).unwrap());
        assert_eq!(
            list(&mut glue)
                .unwrap()
                .iter()
                .map(|section| section.section_id.as_str())
                .collect::<Vec<_>>(),
            ["c", "b", "a"]
        );

        let inserted = insert_at_top(&mut glue, "new", "new").unwrap();
        assert_eq!(list(&mut glue).unwrap()[0], inserted);
    }

    #[test]
    fn move_before_rejects_unavailable_self_and_stale_anchors_without_writes() {
        let mut glue = memory();
        for (id, position) in [("a", 0), ("b", 1024)] {
            upsert(
                &mut glue,
                &ManagedSection {
                    section_id: id.to_string(),
                    logical_path: id.to_string(),
                    position,
                },
            )
            .unwrap();
        }
        let before = list(&mut glue).unwrap();

        assert!(matches!(
            move_before(&mut glue, "missing", None),
            Err(TaskStoreError::SectionReorderUnavailable(_))
        ));
        assert!(matches!(
            move_before(&mut glue, "a", Some("a")),
            Err(TaskStoreError::SectionReorderConflict(_))
        ));
        assert!(matches!(
            move_before(&mut glue, "a", Some("missing")),
            Err(TaskStoreError::SectionReorderConflict(_))
        ));
        assert_eq!(list(&mut glue).unwrap(), before);
    }

    #[test]
    fn move_before_rebalances_dense_and_checked_overflow_ranks() {
        fn seeded(rows: &[(&'static str, i64)]) -> Glue<MemoryStorage> {
            let mut glue = memory();
            for (id, position) in rows {
                upsert(
                    &mut glue,
                    &ManagedSection {
                        section_id: (*id).to_string(),
                        logical_path: (*id).to_string(),
                        position: *position,
                    },
                )
                .unwrap();
            }
            glue
        }

        let mut dense = seeded(&[("a", 0), ("b", 1), ("c", 2)]);
        assert!(move_before(&mut dense, "c", Some("b")).unwrap());
        assert_eq!(positions(&mut dense), [0, 1024, 2048]);

        let mut top_overflow = seeded(&[("a", i64::MIN), ("b", 0)]);
        assert!(move_before(&mut top_overflow, "b", Some("a")).unwrap());
        assert_eq!(positions(&mut top_overflow), [0, 1024]);

        let mut end_overflow = seeded(&[("a", 0), ("b", i64::MAX)]);
        assert!(move_before(&mut end_overflow, "a", None).unwrap());
        assert_eq!(positions(&mut end_overflow), [0, 1024]);

        let mut insert_overflow = seeded(&[("a", i64::MIN)]);
        insert_at_top(&mut insert_overflow, "b", "b").unwrap();
        assert_eq!(positions(&mut insert_overflow), [0, 1024]);
    }

    fn positions(glue: &mut Glue<MemoryStorage>) -> Vec<i64> {
        list(glue)
            .unwrap()
            .iter()
            .map(|section| section.position)
            .collect()
    }
}
