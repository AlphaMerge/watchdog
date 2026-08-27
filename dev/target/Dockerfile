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
      '# A session, so an HTTP Transaction sensor (T-15) has a real multi-step flow to run:' \
      '# /signin sets a cookie and redirects, and /dashboard only greets you by name if the' \
      '# cookie arrived. Getting that wrong is the fault the sensor exists to catch, and it is' \
      '# invisible to a status code.' \
      'map $http_cookie $ms_who {' \
      '  default          anonymous;' \
      '  "~*session=authed" ops;' \
      '}' \
      'server {' \
      '  listen 80 default_server;' \
      '  root /var/www/html;' \
      '  location / { try_files $uri $uri/ =404; }' \
      '  location = /slow { return 200 "slow-ok\n"; }' \
      '  location = /down { return 503 "unavailable\n"; }' \
      '  location = /session {' \
      '    add_header Set-Cookie "session=authed; Path=/";' \
      '    return 200 "token=tok-live-42\n";' \
      '  }' \
      '  location = /signin {' \
      '    add_header Set-Cookie "session=authed; Path=/";' \
      '    return 302 /dashboard;' \
      '  }' \
      '  location = /dashboard { return 200 "welcome $ms_who\n"; }' \
      '  location = /echo { return 200 "t=$arg_t\n"; }' \
      '}' \
    > /etc/nginx/sites-available/default

# A JSON document with the shapes a REST Custom sensor (T-16) has paths for: a status word, a
# gauge, and a list with a state field to filter and count on. Static, so the numbers a live
# check reads are the numbers this file says.
RUN printf '%s' '{"status":"healthy","version":"4.2.1","queue":{"depth":12,"oldest":"4.5"},"nodes":[{"name":"a","state":"up","load":0.4},{"name":"b","state":"down","load":0.95},{"name":"c","state":"down","load":0.7}]}' \
    > /var/www/html/status.json

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 22 80 161/udp
CMD ["/usr/local/bin/start.sh"]
