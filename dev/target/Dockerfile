# A Linux box to point sensors at. Development only.
#
# The other simulators in docker-compose.dev.yml each speak one protocol. This one is a
# *device*: one host that answers on several ports at once, which is what a real monitored
# machine looks like and what the device/sensor object model is shaped around.
#
#   ICMP  — inherent, no daemon needed
#   HTTP  — nginx on 80, serving a page with a known string and a /slow endpoint
#   SSH   — sshd on 22
#   SNMP  — snmpd on 161/udp, community "public", reachable off-loopback
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      nginx openssh-server snmpd snmp iputils-ping iproute2 procps curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Debian's snmpd binds loopback only, which would make it invisible to the probe. The
# address must be fully qualified: net-snmp reads `udp:161` as the *host* 161 on the
# default port, then fails to resolve it and exits.
RUN printf '%s\n' \
      'agentaddress udp:0.0.0.0:161' \
      'rocommunity public default' \
      'sysLocation Development stack (docker-compose.dev.yml)' \
      'sysContact dev@example.invalid' \
      'sysServices 72' \
    > /etc/snmp/snmpd.conf

# A known body, so an HTTP content sensor has something deterministic to match on, and a
# deliberately slow route for exercising response-time thresholds and timeouts.
RUN printf '%s\n' \
      '<!doctype html><meta charset="utf-8">' \
      '<title>ms-target</title>' \
      '<h1>ms-target</h1>' \
      '<p>monitoring-target-ok</p>' \
    > /var/www/html/index.html \
 && printf '%s\n' \
      'server {' \
      '  listen 80 default_server;' \
      '  root /var/www/html;' \
      '  location / { try_files $uri $uri/ =404; }' \
      '  location = /slow { return 200 "slow-ok\n"; }' \
      '  location = /down { return 503 "unavailable\n"; }' \
      '}' \
    > /etc/nginx/sites-available/default

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 22 80 161/udp
CMD ["/usr/local/bin/start.sh"]
