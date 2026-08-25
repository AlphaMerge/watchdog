# The pinned Node toolchain: build, test and lint, and the two services in development.
#
# node:24-bookworm plus the handful of system binaries the product actually shells out to.
# ADR-001 makes the system `ping` binary the default ICMP path, so a toolchain without it
# cannot run or test the sensor that uses it (TASKS.md P-16, found while standing up the
# development target — the image had no `ping` at all).
FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      iputils-ping \
      iproute2 \
 && rm -rf /var/lib/apt/lists/*
