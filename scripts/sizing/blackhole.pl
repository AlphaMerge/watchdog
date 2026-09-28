#!/usr/bin/perl
# A TCP port that never answers, for `probe-starvation.sh` (`P-216`).
#
# It listens with a backlog of 0 and never accepts. The first connection or two complete into the
# accept queue and stay there; after that the kernel drops every SYN, so a client's connect waits
# out its own timeout. Nothing else here needed: Debian always ships Perl, and the smoke image
# has neither iptables nor iproute2.
use strict;
use warnings;
use Socket;

my $port = shift // 9999;
socket(my $listener, PF_INET, SOCK_STREAM, 0) or die "socket: $!";
setsockopt($listener, SOL_SOCKET, SO_REUSEADDR, 1) or die "setsockopt: $!";
bind($listener, sockaddr_in($port, INADDR_LOOPBACK)) or die "bind 127.0.0.1:$port: $!";
listen($listener, 0) or die "listen: $!";
sleep;
