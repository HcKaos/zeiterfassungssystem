#!/bin/sh
# wait-for-it.sh: wait for a host and port to be available

# Author: Giles Hall
# Contributor: Justin Dow
# Website: https://github.com/vishnubob/wait-for-it
#
# This script is a simplified version for common use cases.
# For the full version, please see the original repository.

TIMEOUT=15
QUIET=0
STRICT=0
HOST=
PORT=
CHILD_CMD=""

usage() {
  cat << USAGE >&2
Usage:
  $0 host:port [-s] [-t timeout] [-- command args]
  -h HOST | --host=HOST       Host or IP under test
  -p PORT | --port=PORT       TCP port under test
                                Alternatively, you specify the host and port as host:port
  -s | --strict               Only execute subcommand if the test succeeds
  -q | --quiet                Don't output any status messages
  -t TIMEOUT | --timeout=TIMEOUT
                              Timeout in seconds, zero for no timeout (default 15)
  -- COMMAND ARGS             Execute command with args after the test finishes
USAGE
  exit 1
}

wait_for() {
  if [ "$QUIET" -eq 0 ]; then echo "Waiting for $HOST:$PORT..."; fi
  for i in $(seq $TIMEOUT); do
    if nc -z "$HOST" "$PORT" > /dev/null 2>&1; then
      if [ "$QUIET" -eq 0 ]; then echo "$HOST:$PORT is available after $(expr $i - 1) seconds"; fi
      return 0
    fi
    sleep 1
  done
  echo "Timeout occurred after waiting $TIMEOUT seconds for $HOST:$PORT"
  return 1
}

# process arguments
while [ $# -gt 0 ]
do
  case "$1" in
    *:* )
    HOST=$(printf "%s\n" "$1"| cut -d : -f 1)
    PORT=$(printf "%s\n" "$1"| cut -d : -f 2)
    shift 1
    ;;
    -h | --host)
    HOST="$2"
    if [ "$HOST" = "" ]; then break; fi
    shift 2
    ;;
    --host=*)
    HOST="${1#*=}"
    shift 1
    ;;
    -p | --port)
    PORT="$2"
    if [ "$PORT" = "" ]; then break; fi
    shift 2
    ;;
    --port=*)
    PORT="${1#*=}"
    shift 1
    ;;
    -t | --timeout)
    TIMEOUT="$2"
    if [ "$TIMEOUT" = "" ]; then break; fi
    shift 2
    ;;
    --timeout=*)
    TIMEOUT="${1#*=}"
    shift 1
    ;;
    -s | --strict)
    STRICT=1
    shift 1
    ;;
    -q | --quiet)
    QUIET=1
    shift 1
    ;;
    --)
    shift
    CHILD_CMD="$@"
    break
    ;;
    -*)
    echo "Unknown argument: $1"
    usage
    ;;
    *)
    # If it's not an option or --, then it's the start of the command
    CHILD_CMD="$@"
    break
    ;;
  esac
done

if [ -z "$HOST" ] || [ -z "$PORT" ]; then
  echo "Error: you need to provide a host and port to test."
  usage
fi

wait_for
RESULT=$?

if [ -n "$CHILD_CMD" ]; then
  if [ $RESULT -ne 0 ] && [ "$STRICT" -eq 1 ]; then
    echo "Strict mode: command \"$CHILD_CMD\" will not be executed due to timeout."
    exit $RESULT
  fi
  # Use exec to replace the shell with the child command
  exec $CHILD_CMD
else
  exit $RESULT
fi