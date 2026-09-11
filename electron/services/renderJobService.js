const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

class RenderJobService {
  constructor(projectStore) {
    this.projectStore = projectStore;
    this.jobs = new Map();
  }

  async start({ workspaceRoot, projectId, type = "final", resumedFrom = null }) {
    const paths = this.projectStore.getProjectPaths(workspaceRoot, projectId);
    const previousAttempt = Number(resumedFrom?.attempt || 0);
    const job = {
      schemaVersion: 2,
      id: crypto.randomUUID(),
      projectId,
      type,
      attempt: Math.max(1, previousAttempt + 1),
      resumedFromJobId: resumedFrom?.id || "",
      status: "running",
      canResume: false,
      step: "queued",
      percent: 0,
      message: "Đang chuẩn bị render",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: "",
      error: ""
    };
    job.path = path.join(paths.outputDir, `render-job-${job.id}.json`);
    this.jobs.set(job.id, { job, writeChain: Promise.resolve() });
    await this.projectStore.writeJson(job.path, job);
    await this.projectStore.updateProject(workspaceRoot, projectId, {
      artifacts: {
        activeRenderJobPath: job.path,
        activeRenderJobId: job.id,
        recoverableRenderJobPath: "",
        recoverableRenderJobId: ""
      }
    });
    return job;
  }

  async readJob(jobPath) {
    if (!jobPath) return null;
    try {
      return JSON.parse(await fs.readFile(jobPath, "utf8"));
    } catch (_error) {
      return null;
    }
  }

  async recoverInterruptedJobs({ workspaceRoot }) {
    const projects = await this.projectStore.listProjects(workspaceRoot);
    const recovered = [];
    for (const project of projects) {
      const activePath = project.artifacts?.activeRenderJobPath || "";
      const activeId = project.artifacts?.activeRenderJobId || "";
      if (!activePath || !activeId) continue;
      const job = await this.readJob(activePath);
      if (!job || job.id !== activeId || job.status !== "running") continue;

      const interrupted = {
        ...job,
        schemaVersion: 2,
        status: "interrupted",
        canResume: true,
        message: "Lần xuất trước bị gián đoạn khi ứng dụng đóng. Có thể tiếp tục bằng một attempt mới.",
        error: "application_restarted_during_render",
        interruptedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await this.projectStore.writeJson(activePath, interrupted);
      await this.projectStore.updateProject(workspaceRoot, project.id, {
        status: "render_interrupted",
        statusMessage: "Lần xuất trước bị gián đoạn. Bấm Tiếp tục xuất để chạy lại từ dữ liệu đã lưu.",
        artifacts: {
          activeRenderJobPath: "",
          activeRenderJobId: "",
          recoverableRenderJobPath: activePath,
          recoverableRenderJobId: interrupted.id,
          recoverableRenderJobType: interrupted.type
        }
      });
      recovered.push(interrupted);
    }
    return recovered;
  }

  async prepareResume({ workspaceRoot, projectId }) {
    const project = await this.projectStore.getProject(workspaceRoot, projectId);
    const jobPath = project.artifacts?.recoverableRenderJobPath || "";
    const expectedId = project.artifacts?.recoverableRenderJobId || "";
    const interrupted = await this.readJob(jobPath);
    if (!interrupted || interrupted.id !== expectedId || interrupted.status !== "interrupted") {
      throw new Error("Không tìm thấy render job bị gián đoạn để tiếp tục.");
    }
    const resumedAt = new Date().toISOString();
    await this.projectStore.writeJson(jobPath, {
      ...interrupted,
      status: "resumed",
      canResume: false,
      resumedAt,
      updatedAt: resumedAt,
      finishedAt: resumedAt
    });
    return interrupted;
  }

  progress(jobId, payload = {}) {
    const entry = this.jobs.get(jobId);
    if (!entry) return;
    entry.job = {
      ...entry.job,
      step: payload.step || entry.job.step,
      percent: Number.isFinite(Number(payload.percent)) ? Number(payload.percent) : entry.job.percent,
      message: payload.message || entry.job.message,
      updatedAt: new Date().toISOString()
    };
    entry.writeChain = entry.writeChain
      .catch(() => {})
      .then(() => this.projectStore.writeJson(entry.job.path, entry.job));
  }

  async finish(jobId, status, error = "", { workspaceRoot = "", projectId = "" } = {}) {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    entry.job = {
      ...entry.job,
      status,
      percent: status === "completed" ? 100 : entry.job.percent,
      error: error ? String(error) : "",
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
    await entry.writeChain.catch(() => {});
    await this.projectStore.writeJson(entry.job.path, entry.job);
    this.jobs.delete(jobId);
    if (workspaceRoot && projectId) {
      await this.projectStore.updateProject(workspaceRoot, projectId, {
        artifacts: {
          activeRenderJobPath: "",
          activeRenderJobId: ""
        }
      }).catch(() => {});
    }
    return entry.job;
  }
}

module.exports = RenderJobService;
