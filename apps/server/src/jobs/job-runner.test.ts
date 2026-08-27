import {get} from "node:http";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import {afterEach, describe, expect, it} from "vitest";

import {buildApp} from "../app.js";
import {runMigrations} from "../db/migrations.js";
import {LocalFsAdapter} from "../storage/local-fs-adapter.js";
import {createWebProject} from "../services/web-projects.js";
import {JobRunner, type PipelineStepRequest, type Step} from "./job-runner.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const setup = async (): Promise<{
  database: Database.Database;
  root: string;
  runner: JobRunner;
  storage: LocalFsAdapter;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), "travel-jobs-"));
  const storageRoot = path.join(root, "work");
  await mkdir(storageRoot, {recursive: true});
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  const storage = new LocalFsAdapter(storageRoot);
  const runner = new JobRunner(database, storage);
  cleanups.push(() => rm(root, {force: true, maxRetries: 5, recursive: true, retryDelay: 100}));
  cleanups.push(() => {
    database.close();
  });
  return {database, root, runner, storage};
};

const makeStep = (
  name: string,
  codeVersion: number,
  run: Step["run"],
  invalidates: readonly string[] = [],
): Step => ({codeVersion, invalidates, name, run});

const request = (
  step: Step,
  params: unknown = {value: 1},
  inputHash = "input-hash",
): PipelineStepRequest => ({inputHash, params, step});

describe("JobRunner cache and resume", () => {
  it("restores canonical outputs when a cached step is selected again", async () => {
    const {runner} = await setup();
    let executions = 0;
    const restored: unknown[] = [];
    const step: Step = {
      codeVersion: 1,
      invalidates: ["finalize"],
      name: "music",
      restoreCached: async (output) => {
        restored.push(output);
      },
      run: async () => ({choice: ++executions}),
    };

    await runner.runPipeline({projectId: "p1", steps: [request(step)]});
    const finalize = await runner.runPipeline({
      projectId: "p1",
      steps: [request(makeStep("finalize", 1, async () => ({ok: true})))],
    });
    await runner.runPipeline({projectId: "p1", steps: [request(step)]});

    expect(executions).toBe(1);
    expect(restored).toEqual([{choice: 1}]);
    expect(runner.getSteps(finalize.jobId)[0]?.state).toBe("invalidated");
  });

  it("returns a cache hit on the same input, misses on codeVersion, and honors force", async () => {
    const {runner} = await setup();
    let executions = 0;
    const v1 = makeStep("scan", 1, async (_context, params) => {
      executions += 1;
      return {executions, params};
    });

    const first = await runner.runPipeline({projectId: "p1", steps: [request(v1)]});
    const second = await runner.runPipeline({projectId: "p1", steps: [request(v1)]});
    expect(executions).toBe(1);
    expect(second.outputs.scan).toEqual(first.outputs.scan);
    expect(runner.getSteps(second.jobId)[0]?.state).toBe("cached");

    const v2 = makeStep("scan", 2, v1.run);
    await runner.runPipeline({projectId: "p1", steps: [request(v2)]});
    expect(executions).toBe(2);
    await runner.runPipeline({force: true, projectId: "p1", steps: [request(v2)]});
    expect(executions).toBe(3);
  });

  it("resumes a failed pipeline without executing a successful preceding step again", async () => {
    const {runner} = await setup();
    let firstExecutions = 0;
    let secondExecutions = 0;
    const first = makeStep(
      "prepare",
      1,
      async () => {
        firstExecutions += 1;
        return {ok: true};
      },
      ["fingerprint"],
    );
    const second = makeStep("fingerprint", 1, async () => {
      secondExecutions += 1;
      if (secondExecutions === 1) {
        throw new Error("intentional failure");
      }
      return {ok: true};
    });
    const steps = [request(first), request(second)];

    await expect(runner.runPipeline({jobId: "job-resume", projectId: "p1", steps})).rejects.toThrow(
      "intentional failure",
    );
    expect(runner.getJob("job-resume")?.state).toBe("failed");
    expect(runner.getSteps("job-resume").map((entry) => entry.state)).toEqual([
      "succeeded",
      "failed",
    ]);

    await expect(
      runner.runPipeline({jobId: "job-resume", projectId: "p1", steps}),
    ).resolves.toMatchObject({state: "succeeded"});
    expect(firstExecutions).toBe(1);
    expect(secondExecutions).toBe(2);
    expect(runner.getSteps("job-resume").map((entry) => entry.state)).toEqual([
      "cached",
      "succeeded",
    ]);
  });
});

describe("JobRunner invalidation and cancellation", () => {
  it("keeps an upstream step cached and re-runs only the invalidated ones", async () => {
    const {runner} = await setup();
    let assembleExecutions = 0;
    let timelineExecutions = 0;
    const assemble = makeStep("assemble", 1, async () => {
      assembleExecutions += 1;
      return {assembleExecutions};
    });
    const timeline = makeStep("timeline", 1, async () => {
      timelineExecutions += 1;
      return {timelineExecutions};
    });
    const steps = [request(assemble), request(timeline)];
    await runner.runPipeline({projectId: "p1", steps});

    runner.invalidateSteps("p1", ["timeline", "music", "render", "finalize"]);

    const rerun = await runner.runPipeline({projectId: "p1", steps});
    expect(assembleExecutions).toBe(1);
    expect(timelineExecutions).toBe(2);
    expect(runner.getSteps(rerun.jobId).map((entry) => entry.state)).toEqual([
      "cached",
      "succeeded",
    ]);
  });

  it("resolves a lazy inputHash right before the step runs", async () => {
    const {runner} = await setup();
    let resolved = 0;
    const step = makeStep("scan", 1, async () => ({ok: true}));
    const lazy: PipelineStepRequest = {
      inputHash: async () => {
        resolved += 1;
        return "lazy-hash";
      },
      params: {value: 1},
      step,
    };

    await runner.runPipeline({projectId: "p1", steps: [lazy]});
    const second = await runner.runPipeline({projectId: "p1", steps: [lazy]});

    expect(resolved).toBe(2);
    expect(runner.getSteps(second.jobId)[0]?.state).toBe("cached");
  });

  it("removes tracked partial outputs after success but keeps everything else", async () => {
    const {runner, storage} = await setup();
    const step = makeStep("group-clips", 1, async (context) => {
      await storage.write("clips/p1/final.mp4", Buffer.from("final"));
      context.trackPartialOutput("clips/p1/scratch.tmp");
      await storage.write("clips/p1/scratch.tmp", Buffer.from("scratch"));
      return {ok: true};
    });

    await runner.runPipeline({projectId: "p1", steps: [request(step)]});

    await expect(storage.exists("clips/p1/final.mp4")).resolves.toBe(true);
    await expect(storage.exists("clips/p1/scratch.tmp")).resolves.toBe(false);
  });

  it("aborts the running step and removes every registered partial output", async () => {
    const {runner, storage} = await setup();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocking = makeStep("render", 1, async (context) => {
      const partialKey = "partials/render.tmp.mp4";
      context.trackPartialOutput(partialKey);
      await storage.write(partialKey, Buffer.from("partial"));
      started();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason ?? new Error("cancelled")),
          {once: true},
        );
      });
      return {ok: true};
    });
    const outcome = runner
      .runPipeline({jobId: "job-cancel", projectId: "p1", steps: [request(blocking)]})
      .catch((error: unknown) => error);
    await didStart;
    await expect(storage.exists("partials/render.tmp.mp4")).resolves.toBe(true);

    await expect(runner.cancel("job-cancel")).resolves.toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    await expect(storage.exists("partials/render.tmp.mp4")).resolves.toBe(false);
    expect(runner.getJob("job-cancel")?.state).toBe("cancelled");
    expect(runner.getSteps("job-cancel")[0]?.state).toBe("cancelled");
  });
});

describe("project SSE", () => {
  it("sends the current snapshot before live progress events", async () => {
    const {database, runner, storage} = await setup();
    const project = createWebProject(database, {folderPath: "C:/trip", title: "Test trip"});
    runner.events.publish(project.id, {
      etaSec: 12,
      message: "halfway",
      progress: 0.5,
      state: "running",
      step: "prepare",
    });
    const app = buildApp({database, jobRunner: runner, storage});
    await app.listen({host: "127.0.0.1", port: 0});
    cleanups.push(() => app.close());
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Fastify did not expose a TCP address");
    }

    const payload = await new Promise<string>((resolve, reject) => {
      const request = get(
        `http://127.0.0.1:${String(address.port)}/api/projects/${project.id}/events`,
        (response) => {
          response.setEncoding("utf8");
          let received = "";
          response.on("data", (chunk: string) => {
            received += chunk;
            if (received.includes("\n\n")) {
              resolve(received);
              request.destroy();
            }
          });
          response.once("error", reject);
        },
      );
      request.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") {
          reject(error);
        }
      });
    });

    expect(payload.startsWith("event: snapshot\n")).toBe(true);
    expect(payload).toContain('"step":"prepare"');
    expect(payload).toContain('"progress":0.5');
  });
});
