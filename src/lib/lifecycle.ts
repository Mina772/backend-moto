let shuttingDown = false;

/** Flips readiness to false so a load balancer drains the instance before the socket closes. */
export function beginShutdown() {
  shuttingDown = true;
}

export function isShuttingDown() {
  return shuttingDown;
}
