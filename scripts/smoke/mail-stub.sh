#!/bin/sh
# Stands in for mail(1) in a smoke box (`H-25`), which has no mail to send. Installed as
# /usr/local/bin/mail, ahead of any other on every PATH, systemd's included. Appends what it was
# asked to send to /var/log/smoke-mail.log: one `mail <arguments>` line, the message, then a line
# with a single dot.
{
  printf 'mail %s\n' "$*"
  cat
  printf '.\n'
} >>/var/log/smoke-mail.log
