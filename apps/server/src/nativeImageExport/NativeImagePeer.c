/* T3-CUSTOM(expbkt3): SDK-compiled Darwin checks for the trusted-account worker.
 * No global listener inventory or claim about isolation from same-account code.
 * This library performs no network I/O and returns no native response bytes.
 */
#include <arpa/inet.h>
#include <bsm/libbsm.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define NI_MAX_FDS 65536

typedef struct {
  int fd;
  pid_t child;
  pid_t parent;
  uid_t uid;
  unsigned short port;
  audit_token_t token;
  struct proc_bsdinfo process;
  struct stat channel;
  uint64_t channel_so;
  uint64_t peer_so;
  char executable[PROC_PIDPATHINFO_MAXSIZE];
} ni_parent;

static int ni_socket(pid_t pid, int fd, struct socket_fdinfo *out) {
  memset(out, 0, sizeof(*out));
  return proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, out, sizeof(*out)) == sizeof(*out);
}

static int ni_identity(ni_parent *p) {
  struct stat st;
  struct proc_bsdinfo process;
  audit_token_t token;
  char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
  uid_t uid;
  gid_t gid;
  int peer = 0;
  int type = 0;
  socklen_t size = sizeof(peer);
  if (getpid() != p->child || getppid() != p->parent || getuid() != p->uid ||
      geteuid() != p->uid || fstat(p->fd, &st) != 0 || !S_ISSOCK(st.st_mode) ||
      st.st_dev != p->channel.st_dev || st.st_ino != p->channel.st_ino ||
      getpeereid(p->fd, &uid, &gid) != 0 || uid != p->uid ||
      getsockopt(p->fd, SOL_LOCAL, LOCAL_PEERPID, &peer, &size) != 0 ||
      size != sizeof(peer) || peer != p->parent)
    return 0;
  size = sizeof(type);
  if (getsockopt(p->fd, SOL_SOCKET, SO_TYPE, &type, &size) != 0 ||
      size != sizeof(type) || type != SOCK_STREAM)
    return 0;
  size = sizeof(token);
  if (getsockopt(p->fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) != 0 ||
      size != sizeof(token) || memcmp(&token, &p->token, sizeof(token)) != 0 ||
      audit_token_to_pid(token) != p->parent || audit_token_to_euid(token) != p->uid ||
      audit_token_to_ruid(token) != p->uid ||
      proc_pidpath_audittoken(&token, executable, sizeof(executable)) <= 0 ||
      strcmp(executable, p->executable) != 0 ||
      proc_pidinfo(p->parent, PROC_PIDTBSDINFO, 0, &process, sizeof(process)) != sizeof(process))
    return 0;
  return process.pbi_pid == (uint32_t)p->parent && process.pbi_uid == p->uid &&
         process.pbi_ruid == p->uid && process.pbi_start_tvsec == p->process.pbi_start_tvsec &&
         process.pbi_start_tvusec == p->process.pbi_start_tvusec;
}

/* A positive match is sufficient: no completeness claim about other processes is needed.
 * With a live TCP connection, another listener cannot receive its request bytes.
 */
static int ni_parent_socket(ni_parent *p, const struct socket_fdinfo *channel,
                            const struct sockaddr_in *local, const struct sockaddr_in *remote) {
  int bytes = proc_pidinfo(p->parent, PROC_PIDLISTFDS, 0, NULL, 0);
  if (bytes <= 0 || bytes % sizeof(struct proc_fdinfo) != 0 ||
      bytes > NI_MAX_FDS * (int)sizeof(struct proc_fdinfo))
    return 0;
  /* Spare capacity handles ordinary descriptor creation without accepting a truncated list. */
  size_t capacity = (size_t)bytes + 32 * sizeof(struct proc_fdinfo);
  struct proc_fdinfo *fds = calloc(1, capacity);
  if (fds == NULL) return 0;
  int count = proc_pidinfo(p->parent, PROC_PIDLISTFDS, 0, fds, (int)capacity);
  int found = 0;
  if (count <= 0 || (size_t)count >= capacity || count % sizeof(*fds) != 0) goto done;
  for (size_t i = 0; i < (size_t)count / sizeof(*fds); i++) {
    if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
    struct socket_fdinfo parent;
    if (!ni_socket(p->parent, fds[i].proc_fd, &parent)) continue;
    if (channel != NULL) {
      if (parent.psi.soi_family == AF_UNIX && parent.psi.soi_type == SOCK_STREAM &&
          parent.psi.soi_so != 0 &&
          parent.psi.soi_so == channel->psi.soi_proto.pri_un.unsi_conn_so &&
          parent.psi.soi_proto.pri_un.unsi_conn_so == channel->psi.soi_so)
        found = 1;
    } else if (parent.psi.soi_kind == SOCKINFO_TCP && parent.psi.soi_family == AF_INET &&
               parent.psi.soi_type == SOCK_STREAM && parent.psi.soi_protocol == IPPROTO_TCP &&
               parent.psi.soi_proto.pri_tcp.tcpsi_state == TSI_S_ESTABLISHED &&
               !(parent.psi.soi_options & SO_ACCEPTCONN)) {
      const struct in_sockinfo *in = &parent.psi.soi_proto.pri_tcp.tcpsi_ini;
      if (in->insi_lport == remote->sin_port && in->insi_fport == local->sin_port &&
          in->insi_laddr.ina_46.i46a_addr4.s_addr == remote->sin_addr.s_addr &&
          in->insi_faddr.ina_46.i46a_addr4.s_addr == local->sin_addr.s_addr)
        found = 1;
    }
    if (found) break;
  }
done:
  free(fds);
  return found;
}

void ni_parent_close(void *value) {
  if (value != NULL) {
    memset(value, 0, sizeof(ni_parent));
    free(value);
  }
}

void *ni_parent_open(int fd, const char *expected_executable, unsigned short port) {
  if (expected_executable == NULL || expected_executable[0] != '/' || port == 0) return NULL;
  ni_parent *p = calloc(1, sizeof(*p));
  if (p == NULL) return NULL;
  p->fd = fd;
  p->child = getpid();
  p->parent = getppid();
  p->uid = getuid();
  p->port = port;
  struct sockaddr_un addr;
  struct socket_fdinfo channel;
  socklen_t size = sizeof(addr);
  if (p->parent <= 1 || p->uid != geteuid() ||
      strlen(expected_executable) >= sizeof(p->executable) ||
      getsockname(fd, (struct sockaddr *)&addr, &size) != 0 || addr.sun_family != AF_UNIX ||
      fstat(fd, &p->channel) != 0 || !S_ISSOCK(p->channel.st_mode)) goto refused;
  strcpy(p->executable, expected_executable);
  size = sizeof(p->token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &p->token, &size) != 0 ||
      size != sizeof(p->token) ||
      proc_pidinfo(p->parent, PROC_PIDTBSDINFO, 0, &p->process, sizeof(p->process)) != sizeof(p->process) ||
      !ni_socket(p->child, fd, &channel) || channel.psi.soi_kind != SOCKINFO_UN ||
      !ni_identity(p) || !ni_parent_socket(p, &channel, NULL, NULL)) goto refused;
  p->channel_so = channel.psi.soi_so;
  p->peer_so = channel.psi.soi_proto.pri_un.unsi_conn_so;
  if (p->channel_so == 0 || p->peer_so == 0) goto refused;
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) != 0) goto refused;
  return p;
refused:
  ni_parent_close(p);
  return NULL;
}

int ni_parent_check(void *value) {
  ni_parent *p = value;
  struct socket_fdinfo channel;
  return p != NULL && ni_identity(p) && ni_socket(p->child, p->fd, &channel) &&
         channel.psi.soi_kind == SOCKINFO_UN && channel.psi.soi_so == p->channel_so &&
         channel.psi.soi_proto.pri_un.unsi_conn_so == p->peer_so &&
         ni_parent_socket(p, &channel, NULL, NULL) &&
         ni_identity(p);
}

/* Called before sending an HTTP path, on the exact connected socket used for that GET.
 * An unaccepted connection is refused, never retried here. No bytes are sent by this check.
 */
int ni_connection_check(void *value, int fd) {
  ni_parent *p = value;
  if (p == NULL || !ni_parent_check(p)) return 0;
  struct sockaddr_in local = {0}, remote = {0};
  struct socket_fdinfo socket;
  socklen_t size = sizeof(local);
  if (getsockname(fd, (struct sockaddr *)&local, &size) != 0 || size != sizeof(local)) return 0;
  size = sizeof(remote);
  if (getpeername(fd, (struct sockaddr *)&remote, &size) != 0 || size != sizeof(remote) ||
      local.sin_family != AF_INET || remote.sin_family != AF_INET ||
      local.sin_addr.s_addr != htonl(INADDR_LOOPBACK) ||
      remote.sin_addr.s_addr != htonl(INADDR_LOOPBACK) || remote.sin_port != htons(p->port) ||
      !ni_socket(p->child, fd, &socket) || socket.psi.soi_kind != SOCKINFO_TCP ||
      socket.psi.soi_proto.pri_tcp.tcpsi_state != TSI_S_ESTABLISHED) return 0;
  return ni_parent_socket(p, NULL, &local, &remote) && ni_parent_check(p);
}
