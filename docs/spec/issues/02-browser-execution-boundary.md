# What can the workflow reliably do in a friend's browser?

Type: research
Label: wayfinder:research
Status: resolved
Assignee: browser-research
Blocked by: none
Parent: ../map.md
Context branch: research/workflow-browser-boundary
Asset: ../research/browser-boundary.md

## Question

How should a Chrome Manifest V3 extension connect hosted eve workflows to local job capture, tab groups, and explicit task completion? Establish minimum permissions, service-worker lifetime/offline behavior, secure pairing, remote-code restrictions, scheduling limits, extension distribution, and the defensible boundary for form filling in the first release using primary sources.

## Answer

[Browser execution findings](../research/browser-boundary.md) establish the MV3 capability and reliability boundary. Both hosted and downloadable workflows can use packaged capture and tab-group actions. Browser actions wait for an available browser and a user gesture; task IDs must outlive ephemeral Chrome IDs. For a downloadable pilot, manual declarative file exchange is a viable experiment before a native companion. Universal direct harness control is not established. Runtime choice remains a separate human decision.
