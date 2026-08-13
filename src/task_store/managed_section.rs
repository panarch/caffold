use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        executor::Payload,
        query_builder::{Execute, ExprNode, col, table, text},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, SelectResultExt},
};

#[cfg(test)]
use gluesql::core::data::Schema;

use super::{Result, TaskStoreError};

pub(super) const TABLE_NAME: &str = "managed_sections";

const COLUMN_DEFINITIONS: &[&str] = &["section_id TEXT PRIMARY KEY", "logical_path TEXT"];

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
pub(crate) struct ManagedSection {
    pub section_id: String,
    pub logical_path: String,
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
    sections.sort_by(|left, right| left.section_id.cmp(&right.section_id));
    Ok(sections)
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
                },
            ),
            Err(TaskStoreError::InvalidRow("section_id"))
        ));
    }
}
