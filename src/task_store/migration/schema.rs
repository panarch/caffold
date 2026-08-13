pub(super) mod v1;
pub(super) mod v2;
pub(super) mod v3;
pub(super) mod v4;

use gluesql::{
    core::{
        data::Schema,
        query_builder::{Execute, table},
        store::{GStore, GStoreMut, Planner},
    },
    prelude::Glue,
};
use std::collections::BTreeSet;

use crate::task_store::{Result, TaskStoreError};

fn create_table<S>(
    glue: &mut Glue<S>,
    table_name: &'static str,
    column_definitions: &[&str],
) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let mut query = table(table_name).create_table();
    for definition in column_definitions {
        query = query.add_column(*definition);
    }
    query.execute(glue)?;
    Ok(())
}

fn validate_table<S>(glue: &Glue<S>, table_name: &str, column_definitions: &[&str]) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let actual = glue
        .storage
        .fetch_schema(table_name)?
        .ok_or(TaskStoreError::IncompleteSchema)?;
    let expected = Schema::from_ddl(&format!(
        "CREATE TABLE {table_name} ({});",
        column_definitions.join(", ")
    ))?;
    if actual.column_defs != expected.column_defs {
        return Err(TaskStoreError::InvalidSchemaTable(table_name.to_string()));
    }
    Ok(())
}

fn validate_table_names<S, const N: usize>(glue: &Glue<S>, expected: [&str; N]) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let actual = glue
        .storage
        .fetch_all_schemas()?
        .into_iter()
        .map(|schema| schema.table_name)
        .collect::<BTreeSet<_>>();
    let expected = expected
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(())
}
