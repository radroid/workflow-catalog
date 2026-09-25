import { describe, expect, it } from "vitest";
import { checkCommand, openableUrlProblem, SUPPORTED_WORKFLOW_VERSION } from "./policy";
import { command, DEVICE_ID, OTHER_DEVICE_ID, TASKS } from "./fake-chrome";

describe("opening stored URLs (carried into part C: refuse loopback, private, link-local and metadata targets, and anything but http(s))", () => {
  it("opens a public https job address", () => {
    for (const url of ["https://jobs.example/postings/fernwood-platform-lead", "https://careers.fernwood.example/apply?ref=board#top", "https://8.8.8.8/a", "https://[2001:db8::1]/a"]) {
      expect(openableUrlProblem(url), url).toBeUndefined();
    }
  });

  it("refuses every scheme but https: http, javascript:, file:, chrome:, data:, blob:, about:, view-source:", () => {
    for (const url of ["http://jobs.example/postings/1", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "chrome-extension://abc/page.html", "data:text/html,hi", "blob:https://jobs.example/1", "about:blank", "view-source:https://jobs.example/"]) {
      expect(openableUrlProblem(url), url).toBe("not_https");
    }
  });

  it("refuses loopback, private, link-local, CGNAT and metadata addresses, in every spelling the URL parser accepts", () => {
    const addresses = [
      "https://127.0.0.1/a",
      "https://127.1/a",
      "https://2130706433/a",
      "https://0x7f.0.0.1/a",
      "https://0177.0.0.1/a",
      "https://0.0.0.0/a",
      "https://10.1.2.3/a",
      "https://172.16.0.9/a",
      "https://172.31.255.1/a",
      "https://192.168.1.10/a",
      "https://169.254.169.254/latest/meta-data",
      "https://100.100.100.200/a",
      "https://100.64.0.1/a",
      "https://198.18.0.1/a",
      "https://224.0.0.1/a",
      "https://255.255.255.255/a",
      "https://[::1]/a",
      "https://[::]/a",
      "https://[fe80::1]/a",
      "https://[fc00::1]/a",
      "https://[fd00:ec2::254]/a",
      "https://[::ffff:127.0.0.1]/a",
      "https://[::ffff:169.254.169.254]/a",
      "https://[64:ff9b::a9fe:a9fe]/a",
      "https://[2002:7f00:1::]/a",
      "https://[ff02::1]/a",
    ];
    for (const url of addresses) expect(openableUrlProblem(url), url).toBe("private_host");
  });

  it("refuses local-only names: localhost, *.localhost, single labels, .local, .internal (the metadata name), .lan, .home.arpa", () => {
    for (const url of ["https://localhost/a", "https://localhost./a", "https://api.localhost/a", "https://intranet/a", "https://printer.local/a", "https://metadata.google.internal/computeMetadata/v1", "https://nas.lan/a", "https://router.home.arpa/a"]) {
      expect(openableUrlProblem(url), url).toBe("private_host");
    }
  });

  it("refuses an address carrying a user name or password, and anything that isn't an address", () => {
    expect(openableUrlProblem("https://user:pw@jobs.example/a")).toBe("has_credentials");
    expect(openableUrlProblem("https://user@jobs.example/a")).toBe("has_credentials");
    expect(openableUrlProblem("not a url")).toBe("not_a_url");
    expect(openableUrlProblem("")).toBe("not_a_url");
  });
});

describe("checking a command the contract schema already passed (browser-boundary.md: expiry, device binding, workflow version, task ownership, URL, group size)", () => {
  const now = new Date();

  it("accepts this device's live command for the workflow version it was built for", () => {
    const checked = checkCommand(command(), { deviceId: DEVICE_ID, now });
    expect(checked).toMatchObject({ ok: true });
    expect(SUPPORTED_WORKFLOW_VERSION).toBe("job-assistant@0");
  });

  it("refuses another device's command, an expired one, and another workflow major", () => {
    expect(checkCommand(command({ deviceId: OTHER_DEVICE_ID }), { deviceId: DEVICE_ID, now })).toMatchObject({ ok: false, refusal: "other_device" });
    expect(checkCommand(command({ expiresAt: new Date(now.getTime() - 1).toISOString() }), { deviceId: DEVICE_ID, now })).toMatchObject({ ok: false, refusal: "expired" });
    expect(checkCommand(command({ workflowVersion: "job-assistant@1" }), { deviceId: DEVICE_ID, now })).toMatchObject({ ok: false, refusal: "workflow_version" });
    expect(checkCommand(command({ workflowVersion: "other-workflow@0" }), { deviceId: DEVICE_ID, now })).toMatchObject({ ok: false, refusal: "workflow_version" });
  });

  it("refuses a command naming one task twice, and one with nothing it can open; marks each unsafe address", () => {
    const twice = command({}, [
      { taskId: TASKS[0], jobRevision: 1, url: "https://jobs.example/a" },
      { taskId: TASKS[0], jobRevision: 1, url: "https://jobs.example/b" },
    ]);
    expect(checkCommand(twice, { deviceId: DEVICE_ID, now })).toMatchObject({ ok: false, refusal: "duplicate_task" });
    const nothing = command({}, [{ taskId: TASKS[0], jobRevision: 1, url: "http://127.0.0.1:4310/ui/status" }]);
    expect(checkCommand(nothing, { deviceId: DEVICE_ID, now })).toMatchObject({ ok: false, refusal: "no_openable_item" });
    const mixed = command({}, [
      { taskId: TASKS[0], jobRevision: 1, url: "https://jobs.example/a" },
      { taskId: TASKS[1], jobRevision: 1, url: "https://169.254.169.254/latest" },
    ]);
    const checked = checkCommand(mixed, { deviceId: DEVICE_ID, now });
    expect(checked.ok).toBe(true);
    expect(checked.items.map((item) => item.urlProblem)).toEqual([undefined, "private_host"]);
  });
});
