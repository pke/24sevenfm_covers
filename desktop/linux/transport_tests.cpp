#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "../../lib/tests/doctest.h"
#include "../../lib/http_client.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <thread>
#include <chrono>

// Real loopback sockets exercise curl's streaming/error paths without Internet.
class Server {
    int socket_=-1;
    std::thread worker_;
public:
    unsigned short port=0;
    Server(std::string response, int delayMs=0) {
        socket_=socket(AF_INET,SOCK_STREAM,0);
        sockaddr_in address{};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
        if(socket_<0 || bind(socket_,reinterpret_cast<sockaddr*>(&address),sizeof(address)) || listen(socket_,1))
            throw std::runtime_error("Cannot start fixture server");
        socklen_t size=sizeof(address);getsockname(socket_,reinterpret_cast<sockaddr*>(&address),&size);port=ntohs(address.sin_port);
        worker_=std::thread([this,response=std::move(response),delayMs]{
            int client=accept(socket_,nullptr,nullptr);if(client<0)return;
            char request[4096];recv(client,request,sizeof(request),0);
            std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
            size_t sent=0;while(sent<response.size()){
                const auto n=send(client,response.data()+sent,response.size()-sent,MSG_NOSIGNAL);if(n<=0)break;sent+=size_t(n);
            }
            shutdown(client,SHUT_RDWR);close(client);
        });
    }
    ~Server(){shutdown(socket_,SHUT_RDWR);close(socket_);worker_.join();}
    ssc::HttpResponse get(int timeout=3,const std::atomic<bool>* cancel=nullptr) {
        return ssc::httpRequest("127.0.0.1",port,"/fixture","GET","","",timeout,cancel);
    }
};
TEST_CASE("Linux curl decodes chunking and exposes public cache headers") {
    Server server("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nCache-Control: max-age=30\r\nAge: 2\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
    auto response=server.get();CHECK(response.ok());CHECK(response.body=="hello");CHECK(response.age=="2");CHECK(response.cacheControl=="max-age=30");CHECK(response.headersMs>=0);
}
TEST_CASE("Linux curl does not follow redirects") {
    Server server("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\n\r\n");
    CHECK(server.get().status==302);
}
TEST_CASE("Linux curl rejects oversized and truncated response bodies") {
    Server server("HTTP/1.1 200 OK\r\nContent-Length: 16777217\r\n\r\n"+std::string(16u*1024u*1024u+1,'a'));
    auto response=server.get();CHECK(response.status==0);CHECK(response.body.empty());CHECK(response.error=="response exceeds 16 MiB");
    Server truncated("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort");
    response=truncated.get();CHECK(response.status==0);CHECK(response.body.empty());
}
TEST_CASE("Linux curl cancels an in-flight transfer and enforces timeout") {
    Server server("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",1500);
    std::atomic<bool> cancel{false};std::thread interrupt([&]{std::this_thread::sleep_for(std::chrono::milliseconds(100));cancel=true;});
    auto response=server.get(5,&cancel);interrupt.join();CHECK(response.status==0);CHECK(response.error=="cancelled");
    Server delayed("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",1500);
    CHECK(delayed.get(1).status==0);
}
TEST_CASE("Linux curl rejects destinations that could reinterpret host authority") {
    CHECK(ssc::httpRequest("example.org@localhost",443,"/","GET").error=="Invalid HTTP destination");
    CHECK(ssc::httpRequest("localhost",443,"relative","GET").error=="Invalid HTTP destination");
}
