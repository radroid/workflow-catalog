# Shared workflows and browser tasks

A person adopts a reusable workflow and supplies private context to make it their own. The first workflow helps prepare and complete job applications.

## Language

### Sharing

**Workflow template**:
A reusable definition of an outcome, onboarding requirements, skills, and available actions that can be shared with another person.
_Avoid_: Shared agent account.

**Workflow package**:
The distributable, versioned bundle of a workflow template: skills, schemas, document templates, fixtures, and one runtime adapter.
_Avoid_: Download, zip, repo.

**Catalog**:
The hosted, invite-only site that lists workflow templates, serves their packages, and guides installation. It holds no personal context.
_Avoid_: Marketplace, app, backend.

**Workflow instance**:
One person's private adoption of a particular workflow template version, with their context, preferences, and progress.
_Avoid_: Forked user data.

**Invite**:
The owner's grant that lets one named person sign in to the catalog and install a workflow.
_Avoid_: Account, seat.

### Owning

**Local runner**:
The person's own installation of the supported runtime that executes their workflow instance on their machine, with their own model access.
_Avoid_: Server, backend, agent.

**Workspace**:
The private directory on the person's machine holding their sources, career profile, jobs, applications, and run history.
_Avoid_: Database, cloud, sync.

**Source**:
A category of career information a person accounts for during onboarding, each marked provided, unavailable, or not applicable.
_Avoid_: Upload, connector.

**Connection**:
Access a person grants to a service (for example GitHub) so a source can be read for their workflow instance.

**Career profile**:
The person's reviewed account of their experience: confirmed claims, adjustable presentation, boundaries, and preferences. It is the file the person owns.
_Avoid_: Raw resume dump.

**Claim**:
An assertion about a person's experience. It is a candidate until the person confirms, disputes, or excludes it.
_Avoid_: Verified fact for an unreviewed extraction.

**Evidence**:
A source passage or explicit user statement supporting a claim. Evidence records origin, not independent verification of truth.

**Readiness**:
The state in which every source is accounted for, no claim is still a candidate or disputed, and the person has approved the career profile. Generation is only allowed when ready.

**Revision**:
A proposed change to an approved career profile that takes effect only when the person accepts it, producing a new profile version.

### Applying

**Application**:
A person's intention to apply to a particular role, together with the materials and progress attached to that intention.
_Avoid_: Tab, card.

**Job snapshot**:
The captured content of a posting at a point in time, with a revision number, so a preparation can say exactly what it read.

**Preparation**:
A run that turns a job snapshot and a profile version into an application package whose every claim cites a confirmed claim.
_Avoid_: Generation, tailoring.

**Application session**:
A selected set of applications a person intends to work through in their browser, described by a session manifest.
_Avoid_: Agent conversation.

**Session manifest**:
The declarative list of browser tasks (task ID, job revision, URL) the extension opens as a tab group.

**Browser task**:
A persistent next action for a person, represented when useful by a tab inside an application session.
_Avoid_: Open tab as proof of progress.

**Bridge**:
The paired, loopback-only channel between the extension and the local runner. File import and export is the bridge's fallback.
_Avoid_: API, sync.

### Running

**Run**:
One attempt to execute a workflow operation, with an outcome, inputs, an idempotency key, and recorded usage.

**Catch-up run**:
A scheduled run executed late because the local runner was not available at its scheduled time.

**Skill**:
Instructions describing how a workflow performs a task using its permitted actions.

**Action**:
A specific capability a workflow is allowed to request, such as capturing a job or opening an application session.
