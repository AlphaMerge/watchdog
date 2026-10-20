# MonitoringSystem — the operator's documents

The documents a release installs, in `/opt/ms/docs`, and which one answers the question you
arrived with. The services' units name this directory as their documentation.

## Start here

| If you are…                                  | Read, in this order                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **installing it**                            | [installation](installation.md) → [sizing](sizing.md) → [administration](administration.md)             |
| **upgrading to 1.0**                         | [the release notes](release-notes-1.0.md) → [installation → Upgrading](installation.md#upgrading)       |
| **operating it**                             | [the web UI](web-ui.md) → [administration](administration.md) → [troubleshooting](troubleshooting.md)   |
| **working out why a sensor is in its state** | [the state machine](state-machine.md) → [troubleshooting](troubleshooting.md)                           |
| **automating against it**                    | [the API reference](api-reference.md)                                                                   |
| **adding a sensor type**                     | [adding a sensor type](adding-a-sensor-type.md) → [the sensor reference](sensor-reference.md)           |

## Every document here

| Document                                               | What it is                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [installation.md](installation.md)                     | Installing, the first administrator, remote probes, upgrading, uninstalling        |
| [release-notes-1.0.md](release-notes-1.0.md)           | What 1.0 is and needs, what is in it, every upgrade note, and its known limits     |
| [sizing.md](sizing.md)                                 | How much hardware, from measurements rather than estimates                         |
| [administration.md](administration.md)                 | Roles and rights, device credentials, inheritance, pausing, email, what to watch   |
| [web-ui.md](web-ui.md)                                 | Every view an operator uses, and what each one is for                              |
| [troubleshooting.md](troubleshooting.md)               | Symptoms, and the one number that diagnoses each                                   |
| [runbook-backup-restore.md](runbook-backup-restore.md) | What is in a backup, restoring elsewhere, and what to rehearse                     |
| [state-machine.md](state-machine.md)                   | Sensor state and pause precedence in full: vocabulary, transitions, invariants     |
| [sensor-reference.md](sensor-reference.md)             | Every sensor type: parameters, defaults, channels, requirements. Generated          |
| [api-reference.md](api-reference.md)                   | Every route, its parameters and its responses. Generated from the OpenAPI document |
| [adding-a-sensor-type.md](adding-a-sensor-type.md)     | The `SensorType` contract, the rules the catalogue enforces, and a worked example   |
| [ADR-001-architecture.md](ADR-001-architecture.md)     | The architecture and its decisions, the TimescaleDB licence among them             |

A running core serves the document the API reference is rendered from at `/openapi.json`, so a
client can be generated from the schema the server validates against.

## What these cite and a release does not carry

These documents are written in the source repository, beside the work they describe, and some
paragraphs cite what stays there: a ticket such as `H-37`, a measurement under `findings/`, the
backlog `TASKS.md`, or the design documents `WORKFLOW.MD`, `CAPABILITIES.MD` and `PLAN.md`. A
release does not install those. What an operator needs of each is stated where it is cited, and
the citation says where the evidence is.
