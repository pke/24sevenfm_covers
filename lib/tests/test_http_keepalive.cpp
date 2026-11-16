// Connection reuse across requests: a track change issues up to four requests to
// the same host (poll, cover, queue, next cover). Each one used to open its own
// transport session, so every request paid a fresh TCP (+TLS) handshake.
// Exercises the real platform transport (WinHTTP, NSURLSession or libcurl).
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "http_client.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET socket_t;
static void closeSocket(socket_t s) { closesocket(s); }
static const socket_t kNoSocket = INVALID_SOCKET;
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int socket_t;
static void closeSocket(socket_t s) { close(s); }
static const socket_t kNoSocket = -1;
#endif

namespace {
// A minimal HTTP/1.1 keep-alive server that counts accepted TCP connections.
class KeepAliveServer {
public:
    KeepAliveServer() {
#if defined(_WIN32)
        WSADATA data; WSAStartup(MAKEWORD(2, 2), &data);
#endif
        listener_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        sockaddr_in address = {};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        REQUIRE(listener_ != kNoSocket);
        REQUIRE(bind(listener_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
        REQUIRE(listen(listener_, 8) == 0);
        socklen_t size = sizeof(address);
        getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &size);
        port = ntohs(address.sin_port);
        acceptor_ = std::thread([this] {
            for (;;) {
                socket_t client = accept(listener_, nullptr, nullptr);
                if (client == kNoSocket) return;
                ++connections;
                std::lock_guard<std::mutex> lock(mutex_);
                clients_.push_back(client);
                workers_.emplace_back([client] { serve(client); });
            }
        });
    }
    ~KeepAliveServer() {
        shutdown(listener_, 2); // wakes accept() on POSIX; close alone does not
        closeSocket(listener_);
        acceptor_.join();
        {
            std::lock_guard<std::mutex> lock(mutex_);
            for (socket_t client : clients_) shutdown(client, 2);
        }
        for (auto& worker : workers_) worker.join();
        for (socket_t client : clients_) closeSocket(client);
    }
    unsigned short port = 0;
    std::atomic<int> connections{0};

private:
    static void serve(socket_t client) {
        std::string pending;
        char buffer[4096];
        for (;;) {
            const int n = static_cast<int>(recv(client, buffer, sizeof(buffer), 0));
            if (n <= 0) return;
            pending.append(buffer, static_cast<size_t>(n));
            size_t end;
            while ((end = pending.find("\r\n\r\n")) != std::string::npos) {
                pending.erase(0, end + 4);
                static const std::string reply =
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n"
                    "Connection: keep-alive\r\nKeep-Alive: timeout=30\r\n\r\nok";
                if (send(client, reply.data(), static_cast<int>(reply.size()), 0) <= 0) return;
            }
        }
    }
    socket_t listener_ = kNoSocket;
    std::thread acceptor_;
    std::mutex mutex_;
    std::vector<socket_t> clients_;
    std::vector<std::thread> workers_;
};
} // namespace

TEST_CASE("sequential requests to one host reuse a single keep-alive connection") {
    KeepAliveServer server;
    for (int i = 0; i < 4; ++i) {
        const auto response = ssc::httpRequest("127.0.0.1", server.port, "/r" + std::to_string(i), "GET", "", "", 5);
        REQUIRE(response.ok());
        CHECK(response.body == "ok");
    }
    CHECK(server.connections.load() == 1);
}

TEST_CASE("connection reuse is safe across threads with different timeouts") {
    KeepAliveServer server;
    std::vector<std::thread> threads;
    std::atomic<int> ok{0};
    for (int t = 0; t < 4; ++t) threads.emplace_back([&, t] {
        for (int i = 0; i < 5; ++i)
            if (ssc::httpRequest("127.0.0.1", server.port, "/t", "GET", "", "", 2 + t).body == "ok") ++ok;
    });
    for (auto& thread : threads) thread.join();
    CHECK(ok.load() == 20);
    CHECK(server.connections.load() <= 4); // pooled: at most one live connection per concurrent caller
}
