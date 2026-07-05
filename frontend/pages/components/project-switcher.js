import {
  createProject,
  deleteProject,
  getProjectCandidate,
  listProjects,
  openProject,
  renameProject,
} from "../../api.js";
import { escapeHtml } from "../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../components/icons.js";

const POPOVER_ID = "caffold-projects-popover";

class CaffoldProjectSwitcher extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.projectRequestId = 0;
    this.currentPath = "";
    this.routedProject = null;
    this.projectOverrides = new Map();
    this.state = {
      projects: [],
      candidate: null,
      currentProjectId: null,
      error: null,
    };
    this.editingId = null;
    this.addEventListener("click", (event) => {
      this.handleClick(event);
    });
    this.addEventListener("submit", (event) => {
      this.handleSubmit(event);
    });
    this.boundIconsReady = () => this.renderKeepingPopover();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setState(nextState) {
    this.state = {
      projects: nextState.projects ?? [],
      candidate: nextState.candidate ?? null,
      currentProjectId: nextState.currentProjectId ?? null,
      error: nextState.error ?? null,
    };
    if (!this.state.projects.some((project) => project.id === this.editingId)) {
      this.editingId = null;
    }
    this.renderKeepingPopover();
  }

  async refresh(path = "") {
    const requestId = ++this.projectRequestId;
    this.currentPath = path;

    try {
      const [projectsPayload, candidatePayload] = await Promise.all([
        listProjects(),
        getProjectCandidate(path),
      ]);

      if (requestId !== this.projectRequestId) {
        return null;
      }

      const projects = (projectsPayload.projects ?? []).map(
        (project) => this.projectOverrides.get(project.id) ?? project,
      );
      const candidate = candidatePayload.candidate ?? null;
      const currentProjectId = candidate?.alreadyRegistered ? candidate.projectId : null;
      const routedProject =
        currentProjectId && this.routedProject?.id === currentProjectId
          ? this.routedProject
          : null;
      this.routedProject =
        projects.find((project) => project.id === currentProjectId) ?? routedProject;

      this.setState({
        projects,
        candidate,
        currentProjectId,
        error: null,
      });
      return {
        projects,
        candidate,
        currentProjectId,
      };
    } catch (error) {
      if (requestId !== this.projectRequestId) {
        return null;
      }

      this.setContextError(error);
      return null;
    }
  }

  setCurrentProject(project) {
    if (!project?.id) {
      return;
    }

    this.invalidateProjectRequests();
    const existingProject = this.state.projects.find((candidate) => candidate.id === project.id);
    const nextProject = existingProject ?? project;
    this.projectOverrides.set(nextProject.id, nextProject);
    const projects = this.upsertProject(nextProject);
    this.routedProject = nextProject;
    this.setState({
      projects,
      candidate: this.state.candidate,
      currentProjectId: nextProject.id,
      error: null,
    });
  }

  setContextError(error) {
    this.invalidateProjectRequests();
    this.routedProject = null;
    this.setState({
      projects: this.state.projects,
      candidate: null,
      currentProjectId: null,
      error,
    });
  }

  clearContext(options = {}) {
    this.invalidateProjectRequests();
    this.routedProject = null;
    this.setState({
      projects: this.state.projects,
      candidate: null,
      currentProjectId: null,
      error: options.error ?? null,
    });
  }

  upsertProject(project) {
    const projects = this.state.projects.filter((candidate) => candidate.id !== project.id);
    return [project, ...projects];
  }

  invalidateProjectRequests() {
    this.projectRequestId += 1;
  }

  updateProjectRecord(project) {
    if (!project?.id) {
      return;
    }

    this.invalidateProjectRequests();
    this.projectOverrides.set(project.id, project);
    const projects = this.upsertProject(project);
    if (this.routedProject?.id === project.id) {
      this.routedProject = project;
    }
    this.setState({
      projects,
      candidate: this.state.candidate,
      currentProjectId: this.state.currentProjectId,
      error: null,
    });
  }

  async handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const { action, projectId } = button.dataset;

    if (action === "register-current-project") {
      this.closePopover();
      await this.registerCurrentProject();
      return;
    }

    if (action === "open-project" && projectId) {
      this.closePopover();
      await this.openRegisteredProject(projectId);
      return;
    }

    if (action === "rename-project" && projectId) {
      this.editingId = projectId;
      this.renderKeepingPopover({ focusSelector: "input[name='name']" });
      return;
    }

    if (action === "cancel-rename") {
      this.editingId = null;
      this.renderKeepingPopover();
      return;
    }

    if (action === "delete-project" && projectId) {
      await this.deleteRegisteredProject(projectId);
    }
  }

  closePopover() {
    this.querySelector(".project-popover")?.hidePopover?.();
  }

  async handleSubmit(event) {
    const form = event.target.closest("form[data-action='save-rename']");
    if (!form) {
      return;
    }

    event.preventDefault();
    const projectId = form.dataset.projectId;
    const name = new FormData(form).get("name")?.toString() ?? "";
    this.editingId = null;
    await this.renameRegisteredProject(projectId, name);
  }

  async registerCurrentProject() {
    const candidate = this.state.candidate;
    if (!candidate || candidate.alreadyRegistered) {
      return;
    }

    try {
      const project = await createProject({
        rootPath: candidate.rootPath,
        name: candidate.name,
      });
      this.setCurrentProject(project);
      this.dispatchProjectSelected(project);
    } catch (error) {
      this.setContextError(error);
    }
  }

  async openRegisteredProject(id) {
    if (!id) {
      return;
    }

    try {
      const project = await openProject(id);
      this.setCurrentProject(project);
      this.dispatchProjectSelected(project);
    } catch (error) {
      this.setContextError(error);
    }
  }

  async renameRegisteredProject(id, name) {
    if (!id) {
      return;
    }

    try {
      const project = await renameProject(id, name);
      this.updateProjectRecord(project);
    } catch (error) {
      this.setContextError(error);
    }
  }

  async deleteRegisteredProject(id) {
    if (!id) {
      return;
    }

    const project = this.state.projects.find((candidate) => candidate.id === id);
    const name = project?.name ?? "this project";
    if (!window.confirm(`Delete ${name} from Caffold projects? Files are not deleted.`)) {
      return;
    }

    try {
      await deleteProject(id);
      this.projectOverrides.delete(id);
      await this.refresh(this.currentPath);
    } catch (error) {
      this.setContextError(error);
    }
  }

  dispatchProjectSelected(project) {
    this.dispatchEvent(
      new CustomEvent("caffold:project-selected", {
        bubbles: true,
        detail: { project },
      }),
    );
  }

  renderKeepingPopover(options = {}) {
    const wasOpen = this.querySelector(".project-popover")?.matches(":popover-open");
    this.render();

    if (wasOpen) {
      this.querySelector(".project-popover")?.showPopover?.();
    }

    if (options.focusSelector) {
      requestAnimationFrame(() => {
        const target = this.querySelector(options.focusSelector);
        target?.focus();
        target?.select?.();
      });
    }
  }

  render() {
    const currentProject = this.currentProject();
    const candidate = this.state.candidate;
    const label = currentProject?.name ?? (candidate ? "Register" : "Project");
    const pathLabel = currentProject?.relativePath ?? candidate?.relativePath ?? "No repo";
    const activeClass = currentProject ? " is-active" : candidate ? " has-candidate" : "";

    this.innerHTML = `
      <button
        type="button"
        class="project-switcher-button${activeClass}"
        popovertarget="${POPOVER_ID}"
        aria-label="Projects"
        title="Projects"
      >
        ${renderInlineIcon("FolderGit2", "Projects", "project-switcher-icon")}
        <span class="project-switcher-label">${escapeHtml(label)}</span>
        <span class="project-switcher-path">${escapeHtml(pathLabel)}</span>
      </button>
      <section
        id="${POPOVER_ID}"
        class="project-popover"
        popover="auto"
        aria-label="Projects"
      >
        <header class="project-popover-header">
          <h2>Projects</h2>
          <span>${escapeHtml(`${this.state.projects.length}`)}</span>
        </header>
        ${this.renderError()}
        ${this.renderCandidate()}
        ${this.renderProjectList()}
      </section>
    `;
  }

  renderError() {
    if (!this.state.error) {
      return "";
    }

    return `
      <p class="project-message is-error">${escapeHtml(this.state.error.message)}</p>
    `;
  }

  renderCandidate() {
    const candidate = this.state.candidate;
    if (!candidate || candidate.alreadyRegistered) {
      return "";
    }

    return `
      <section class="project-candidate">
        <div class="project-candidate-copy">
          <strong>${escapeHtml(candidate.name)}</strong>
          <span>${escapeHtml(candidate.relativePath)}</span>
        </div>
        <button
          type="button"
          class="project-action"
          data-action="register-current-project"
        >
          Register
        </button>
      </section>
    `;
  }

  renderProjectList() {
    if (this.state.projects.length === 0) {
      return `<p class="project-message">No projects yet.</p>`;
    }

    return `
      <ol class="project-list">
        ${this.state.projects.map((project) => this.renderProject(project)).join("")}
      </ol>
    `;
  }

  renderProject(project) {
    if (project.id === this.editingId) {
      return this.renderRenameForm(project);
    }

    const selected = project.id === this.currentProject()?.id;

    return `
      <li class="project-row${selected ? " is-current" : ""}">
        <button
          type="button"
          class="project-open"
          data-action="open-project"
          data-project-id="${escapeHtml(project.id)}"
          aria-current="${selected ? "true" : "false"}"
        >
          <span class="project-name">${escapeHtml(project.name)}</span>
          <span class="project-path">${escapeHtml(project.relativePath)}</span>
        </button>
        <button
          type="button"
          class="project-icon-button"
          data-action="rename-project"
          data-project-id="${escapeHtml(project.id)}"
          aria-label="${escapeHtml(`Rename ${project.name}`)}"
          title="Rename"
        >
          ${renderInlineIcon("Pencil", "Rename", "project-row-icon")}
        </button>
        <button
          type="button"
          class="project-icon-button is-danger"
          data-action="delete-project"
          data-project-id="${escapeHtml(project.id)}"
          aria-label="${escapeHtml(`Delete ${project.name}`)}"
          title="Delete project record"
        >
          ${renderInlineIcon("Trash2", "Delete", "project-row-icon")}
        </button>
      </li>
    `;
  }

  renderRenameForm(project) {
    return `
      <li class="project-row is-editing">
        <form data-action="save-rename" data-project-id="${escapeHtml(project.id)}">
          <label class="sr-only" for="project-name-${escapeHtml(project.id)}">Project name</label>
          <input
            id="project-name-${escapeHtml(project.id)}"
            name="name"
            value="${escapeHtml(project.name)}"
            autocomplete="off"
          >
          <button type="submit" class="project-action">Save</button>
          <button type="button" class="project-action is-secondary" data-action="cancel-rename">
            Cancel
          </button>
        </form>
      </li>
    `;
  }

  currentProject() {
    if (!this.state.currentProjectId) {
      return null;
    }

    return (
      this.state.projects.find((project) => project.id === this.state.currentProjectId) ??
      (this.routedProject?.id === this.state.currentProjectId ? this.routedProject : null)
    );
  }

  get currentProjectId() {
    return this.state.currentProjectId;
  }
}

customElements.define("caffold-project-switcher", CaffoldProjectSwitcher);
