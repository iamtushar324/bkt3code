/**
 * BK desktop nightlies increment the committed patch before packaging, while a
 * source checkout from the same commit still reports the committed version.
 */
const BK_DESKTOP_NIGHTLY_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)-(?:stage|production)-nightly\.\d{8}\.\d+$/;
const SERVER_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function isBkDesktopNightlyEquivalentToServer(
  clientVersion: string,
  serverVersion: string,
): boolean {
  const client = BK_DESKTOP_NIGHTLY_PATTERN.exec(clientVersion);
  const server = SERVER_VERSION_PATTERN.exec(serverVersion);
  if (!client || !server) return false;

  return (
    client[1] === server[1] &&
    client[2] === server[2] &&
    Number(client[3]) === Number(server[3]) + 1
  );
}
