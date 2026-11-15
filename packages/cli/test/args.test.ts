import { describe, expect, it } from "vitest";
import { UsageError, parseCli, type RunArgs } from "../src/args.ts";

const run = (...argv: string[]) => parseCli(["run", ...argv]) as RunArgs;

describe("parseCli", () => {
  it("shows help with no arguments, help, or -h", () => {
    expect(parseCli([])).toEqual({ command: "help", topic: null });
    expect(parseCli(["help", "run"])).toEqual({ command: "help", topic: "run" });
    expect(parseCli(["--help"]).command).toBe("help");
    expect(parseCli(["run", "-h"])).toEqual({ command: "help", topic: "run" });
    expect(parseCli(["--version"]).command).toBe("version");
  });

  it("parses run with defaults", () => {
    const a = run("./resumes");
    expect(a).toMatchObject({
      inputs: ["./resumes"],
      campaign: "",
      campaignId: null,
      source: "Resume Intake",
      stage: "LEAD",
      dryRun: false,
      fake: false,
      sink: null,
      plain: false,
      json: false,
      parallel: null,
    });
  });

  it("takes several inputs and every flag", () => {
    const a = run("a.zip", "folder", "--campaign", "Backend Engineer", "--campaign-id", "3", "--source", " Careers page ", "--stage", "screening",
      "--dry-run", "--fake", "--sink", "http://127.0.0.1:47900", "--mint-token", "--parallel", "8", "--jd", "jd.txt", "--platform", "Web",
      "--drive-folder", "abc", "--workdir", "w", "--plain");
    expect(a.inputs).toEqual(["a.zip", "folder"]);
    expect(a).toMatchObject({
      campaign: "Backend Engineer", campaignId: 3, source: "Careers page", stage: "SCREENING", dryRun: true, fake: true,
      sink: "http://127.0.0.1:47900", mintToken: true, parallel: 8, jdFile: "jd.txt", platform: "Web", driveFolder: "abc", workdir: "w", plain: true,
    });
  });

  it("accepts flags before the inputs", () => {
    expect(run("--fake", "x.zip").inputs).toEqual(["x.zip"]);
  });

  it.each([
    [["run"], /at least one folder or zip/],
    [["run", "x", "--parallel", "0"], /--parallel must be from 1 to 16/],
    [["run", "x", "--parallel", "abc"], /whole number/],
    [["run", "x", "--stage", "not valid!"], /--stage/],
    [["run", "x", "--sink", "ftp://h"], /http:\/\/ or https:\/\//],
    [["run", "x", "--sink", "nonsense"], /full URL/],
    [["run", "x", "--mint-token"], /needs --sink/],
    [["run", "x", "--campaign-id", "2"], /need --sink/],
    [["run", "x", "--sink", "http://h", "--token", "t", "--mint-token"], /either/],
    [["run", "x", "--bogus"], /bogus/],
    [["frobnicate"], /Unknown command/],
    [["serve", "extra"], /Unexpected/],
    [["serve", "--port", "70000"], /--port/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCli(argv as string[])).toThrow(UsageError);
    expect(() => parseCli(argv as string[])).toThrow(message as RegExp);
  });

  it("parses serve and app", () => {
    expect(parseCli(["serve"])).toEqual({ command: "serve", port: null, open: true, fake: false });
    expect(parseCli(["serve", "--port", "47835", "--no-open"])).toEqual({ command: "serve", port: 47835, open: false, fake: false });
    expect(parseCli(["app"])).toEqual({ command: "app", url: null, port: null, serve: false, fake: false });
    expect(parseCli(["app", "--url", "http://localhost:5173", "--serve"])).toEqual({ command: "app", url: "http://localhost:5173", port: null, serve: true, fake: false });
  });
});
