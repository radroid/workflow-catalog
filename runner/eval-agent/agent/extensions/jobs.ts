// Same one-line mount as runner/agent/extensions/jobs.ts. eve resolves a mount
// file statically, so it must name the package itself; a re-export of the
// runner's mount file is rejected ("has no compile or runtime usage").
export { default } from "@workflow-catalog/job-assistant-eve";
