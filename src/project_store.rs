use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use gluesql::{
    core::{
        data::Value,
        executor::Payload,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Error as GlueError, Glue, MemoryStorage, RedbStorage},
};
use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

const MAX_PROJECT_ID_ATTEMPTS: usize = 16;

const CREATE_PROJECTS_TABLE: &str = "
    CREATE TABLE IF NOT EXISTS projects (
        id TEXT,
        name TEXT,
        root_path TEXT,
        created_ms INTEGER,
        updated_ms INTEGER,
        last_opened_ms INTEGER NULL
    )
";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_ms: u64,
    pub updated_ms: u64,
    pub last_opened_ms: Option<u64>,
}

#[derive(Debug, Error)]
pub enum ProjectStoreError {
    #[error("project was not found: {0}")]
    NotFound(String),
    #[error("project name cannot be empty")]
    EmptyName,
    #[error("unexpected project store payload")]
    UnexpectedPayload,
    #[error("invalid project row: {0}")]
    InvalidRow(&'static str),
    #[error("project store mutex was poisoned")]
    Poisoned,
    #[error("could not allocate project id after repeated collisions")]
    IdCollision,
    #[error("project store error: {0}")]
    Glue(#[from] GlueError),
    #[error("filesystem error while preparing project store: {0}")]
    Io(#[from] std::io::Error),
}

pub type ProjectStoreResult<T> = Result<T, ProjectStoreError>;

#[derive(Clone)]
pub enum ProjectStore {
    Memory(Arc<Mutex<Glue<MemoryStorage>>>),
    Redb(Arc<Mutex<Glue<RedbStorage>>>),
}

impl ProjectStore {
    pub fn memory() -> ProjectStoreResult<Self> {
        let store = Self::Memory(Arc::new(Mutex::new(Glue::new(MemoryStorage::default()))));
        store.initialize_schema()?;
        Ok(store)
    }

    pub fn redb(path: impl AsRef<Path>) -> ProjectStoreResult<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }

        let store = Self::Redb(Arc::new(Mutex::new(Glue::new(RedbStorage::new(path)?))));
        store.initialize_schema()?;
        Ok(store)
    }

    pub fn initialize_schema(&self) -> ProjectStoreResult<()> {
        match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                initialize_schema(&mut *glue)
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                initialize_schema(&mut *glue)
            }
        }
    }

    pub fn list_projects(&self) -> ProjectStoreResult<Vec<ProjectRecord>> {
        let mut projects = match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                list_projects(&mut *glue)?
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                list_projects(&mut *glue)?
            }
        };

        projects.sort_by(|left, right| {
            right
                .last_opened_ms
                .cmp(&left.last_opened_ms)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
                .then_with(|| left.root_path.cmp(&right.root_path))
        });

        Ok(projects)
    }

    pub fn find_by_root_path(&self, root_path: &str) -> ProjectStoreResult<Option<ProjectRecord>> {
        match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                find_by_root_path(&mut *glue, root_path)
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                find_by_root_path(&mut *glue, root_path)
            }
        }
    }

    pub fn create_project(&self, name: &str, root_path: &str) -> ProjectStoreResult<ProjectRecord> {
        let name = normalize_name(name)?;
        if let Some(project) = self.find_by_root_path(root_path)? {
            return Ok(project);
        }

        let now = now_ms();
        let project = ProjectRecord {
            id: self.create_project_id()?,
            name,
            root_path: root_path.to_string(),
            created_ms: now,
            updated_ms: now,
            last_opened_ms: None,
        };

        match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                insert_project(&mut *glue, &project)?
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                insert_project(&mut *glue, &project)?
            }
        }

        Ok(project)
    }

    pub fn rename_project(&self, id: &str, name: &str) -> ProjectStoreResult<ProjectRecord> {
        let name = normalize_name(name)?;
        let now = now_ms();
        let updated = match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                rename_project(&mut *glue, id, &name, now)?
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                rename_project(&mut *glue, id, &name, now)?
            }
        };

        if updated == 0 {
            return Err(ProjectStoreError::NotFound(id.to_string()));
        }

        self.get_project(id)
    }

    pub fn delete_project(&self, id: &str) -> ProjectStoreResult<()> {
        let deleted = match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                delete_project(&mut *glue, id)?
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                delete_project(&mut *glue, id)?
            }
        };

        if deleted == 0 {
            return Err(ProjectStoreError::NotFound(id.to_string()));
        }

        Ok(())
    }

    pub fn open_project(&self, id: &str) -> ProjectStoreResult<ProjectRecord> {
        let now = now_ms();
        let updated = match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                touch_project_opened(&mut *glue, id, now)?
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                touch_project_opened(&mut *glue, id, now)?
            }
        };

        if updated == 0 {
            return Err(ProjectStoreError::NotFound(id.to_string()));
        }

        self.get_project(id)
    }

    pub fn get_project(&self, id: &str) -> ProjectStoreResult<ProjectRecord> {
        let project = match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                get_project(&mut *glue, id)?
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                get_project(&mut *glue, id)?
            }
        };

        project.ok_or_else(|| ProjectStoreError::NotFound(id.to_string()))
    }

    fn create_project_id(&self) -> ProjectStoreResult<String> {
        for _ in 0..MAX_PROJECT_ID_ATTEMPTS {
            let id = new_project_id();
            match self.get_project(&id) {
                Ok(_) => continue,
                Err(ProjectStoreError::NotFound(_)) => return Ok(id),
                Err(error) => return Err(error),
            }
        }

        Err(ProjectStoreError::IdCollision)
    }
}

fn lock_glue<T>(glue: &Arc<Mutex<T>>) -> ProjectStoreResult<MutexGuard<'_, T>> {
    glue.lock().map_err(|_| ProjectStoreError::Poisoned)
}

fn initialize_schema<S>(glue: &mut Glue<S>) -> ProjectStoreResult<()>
where
    S: GStore + GStoreMut + Planner,
{
    glue.execute(CREATE_PROJECTS_TABLE)?;
    Ok(())
}

fn list_projects<S>(glue: &mut Glue<S>) -> ProjectStoreResult<Vec<ProjectRecord>>
where
    S: GStore + GStoreMut + Planner,
{
    let rows = select_rows(glue.execute(
        "
            SELECT id, name, root_path, created_ms, updated_ms, last_opened_ms
            FROM projects
            ",
    )?)?;

    rows.iter().map(project_from_row).collect()
}

fn find_by_root_path<S>(
    glue: &mut Glue<S>,
    root_path: &str,
) -> ProjectStoreResult<Option<ProjectRecord>>
where
    S: GStore + GStoreMut + Planner,
{
    let rows = select_rows(glue.execute(format!(
        "
            SELECT id, name, root_path, created_ms, updated_ms, last_opened_ms
            FROM projects
            WHERE root_path = {}
            ",
        sql_string(root_path)
    ))?)?;

    rows.first().map(project_from_row).transpose()
}

fn get_project<S>(glue: &mut Glue<S>, id: &str) -> ProjectStoreResult<Option<ProjectRecord>>
where
    S: GStore + GStoreMut + Planner,
{
    let rows = select_rows(glue.execute(format!(
        "
            SELECT id, name, root_path, created_ms, updated_ms, last_opened_ms
            FROM projects
            WHERE id = {}
            ",
        sql_string(id)
    ))?)?;

    rows.first().map(project_from_row).transpose()
}

fn insert_project<S>(glue: &mut Glue<S>, project: &ProjectRecord) -> ProjectStoreResult<()>
where
    S: GStore + GStoreMut + Planner,
{
    glue.execute(format!(
        "
        INSERT INTO projects
            (id, name, root_path, created_ms, updated_ms, last_opened_ms)
        VALUES
            ({}, {}, {}, {}, {}, NULL)
        ",
        sql_string(&project.id),
        sql_string(&project.name),
        sql_string(&project.root_path),
        project.created_ms,
        project.updated_ms
    ))?;

    Ok(())
}

fn rename_project<S>(
    glue: &mut Glue<S>,
    id: &str,
    name: &str,
    updated_ms: u64,
) -> ProjectStoreResult<usize>
where
    S: GStore + GStoreMut + Planner,
{
    update_count(glue.execute(format!(
        "
            UPDATE projects
            SET name = {}, updated_ms = {}
            WHERE id = {}
            ",
        sql_string(name),
        updated_ms,
        sql_string(id)
    ))?)
}

fn delete_project<S>(glue: &mut Glue<S>, id: &str) -> ProjectStoreResult<usize>
where
    S: GStore + GStoreMut + Planner,
{
    delete_count(glue.execute(format!(
        "
            DELETE FROM projects
            WHERE id = {}
            ",
        sql_string(id)
    ))?)
}

fn touch_project_opened<S>(
    glue: &mut Glue<S>,
    id: &str,
    last_opened_ms: u64,
) -> ProjectStoreResult<usize>
where
    S: GStore + GStoreMut + Planner,
{
    update_count(glue.execute(format!(
        "
            UPDATE projects
            SET last_opened_ms = {}, updated_ms = {}
            WHERE id = {}
            ",
        last_opened_ms,
        last_opened_ms,
        sql_string(id)
    ))?)
}

fn select_rows(payloads: Vec<Payload>) -> ProjectStoreResult<Vec<HashMap<String, Value>>> {
    let Some(payload) = payloads.into_iter().next() else {
        return Err(ProjectStoreError::UnexpectedPayload);
    };

    let Payload::Select { labels, rows } = payload else {
        return Err(ProjectStoreError::UnexpectedPayload);
    };

    Ok(rows
        .into_iter()
        .map(|row| labels.iter().cloned().zip(row).collect())
        .collect())
}

fn update_count(payloads: Vec<Payload>) -> ProjectStoreResult<usize> {
    let Some(payload) = payloads.into_iter().next() else {
        return Err(ProjectStoreError::UnexpectedPayload);
    };

    match payload {
        Payload::Update(count) => Ok(count),
        _ => Err(ProjectStoreError::UnexpectedPayload),
    }
}

fn delete_count(payloads: Vec<Payload>) -> ProjectStoreResult<usize> {
    let Some(payload) = payloads.into_iter().next() else {
        return Err(ProjectStoreError::UnexpectedPayload);
    };

    match payload {
        Payload::Delete(count) => Ok(count),
        _ => Err(ProjectStoreError::UnexpectedPayload),
    }
}

fn project_from_row(row: &HashMap<String, Value>) -> ProjectStoreResult<ProjectRecord> {
    Ok(ProjectRecord {
        id: required_string(row, "id")?,
        name: required_string(row, "name")?,
        root_path: required_string(row, "root_path")?,
        created_ms: required_u64(row, "created_ms")?,
        updated_ms: required_u64(row, "updated_ms")?,
        last_opened_ms: optional_u64(row, "last_opened_ms")?,
    })
}

fn required_string(row: &HashMap<String, Value>, key: &'static str) -> ProjectStoreResult<String> {
    match row.get(key) {
        Some(Value::Str(value)) => Ok(value.clone()),
        _ => Err(ProjectStoreError::InvalidRow(key)),
    }
}

fn required_u64(row: &HashMap<String, Value>, key: &'static str) -> ProjectStoreResult<u64> {
    match row.get(key) {
        Some(Value::I64(value)) if *value >= 0 => Ok(*value as u64),
        Some(Value::U64(value)) => Ok(*value),
        _ => Err(ProjectStoreError::InvalidRow(key)),
    }
}

fn optional_u64(
    row: &HashMap<String, Value>,
    key: &'static str,
) -> ProjectStoreResult<Option<u64>> {
    match row.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(Value::I64(value)) if *value >= 0 => Ok(Some(*value as u64)),
        Some(Value::U64(value)) => Ok(Some(*value)),
        _ => Err(ProjectStoreError::InvalidRow(key)),
    }
}

fn normalize_name(name: &str) -> ProjectStoreResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ProjectStoreError::EmptyName);
    }

    Ok(name.to_string())
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn new_project_id() -> String {
    let uuid = Uuid::new_v4();
    let bytes = uuid.as_bytes();
    format!(
        "{:08x}",
        u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_lists_renames_opens_and_deletes_projects() {
        let store = ProjectStore::memory().unwrap();
        let created = store
            .create_project("Codger", "/Users/example/codger")
            .unwrap();

        assert_eq!(created.name, "Codger");
        assert_eq!(created.root_path, "/Users/example/codger");
        assert_eq!(created.id.len(), 8);
        assert!(created.id.chars().all(is_lower_hex_digit));
        assert!(created.last_opened_ms.is_none());

        let duplicate = store
            .create_project("Ignored", "/Users/example/codger")
            .unwrap();
        assert_eq!(duplicate.id, created.id);
        assert_eq!(store.list_projects().unwrap().len(), 1);

        let renamed = store.rename_project(&created.id, "Codger UI").unwrap();
        assert_eq!(renamed.name, "Codger UI");

        let opened = store.open_project(&created.id).unwrap();
        assert!(opened.last_opened_ms.is_some());

        store.delete_project(&created.id).unwrap();
        assert!(store.list_projects().unwrap().is_empty());
    }

    #[test]
    fn rejects_empty_names() {
        let store = ProjectStore::memory().unwrap();

        assert!(matches!(
            store.create_project(" ", "/tmp/codger"),
            Err(ProjectStoreError::EmptyName)
        ));
    }

    fn is_lower_hex_digit(character: char) -> bool {
        character.is_ascii_digit() || ('a'..='f').contains(&character)
    }
}
