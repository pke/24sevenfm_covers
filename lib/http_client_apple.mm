// Native Apple TLS; bounded streaming, cancellation and no automatic redirects.
#import <Foundation/Foundation.h>
#include "http_client.h"
#include <chrono>

static constexpr NSUInteger kResponseLimit = 16u * 1024u * 1024u;

@interface SSCHttpDelegate : NSObject <NSURLSessionDataDelegate> {
@public
    ssc::HttpResponse result;
    std::chrono::steady_clock::time_point started;
}
@property(nonatomic, strong) NSMutableData* data;
@property(nonatomic, strong) dispatch_semaphore_t finished;
@end

@implementation SSCHttpDelegate
- (instancetype)init {
    if ((self = [super init])) {
        _data = [NSMutableData data];
        _finished = dispatch_semaphore_create(0);
        started = std::chrono::steady_clock::now();
    }
    return self;
}
- (void)URLSession:(NSURLSession*)session dataTask:(NSURLSessionDataTask*)task
    didReceiveResponse:(NSURLResponse*)response
    completionHandler:(void (^)(NSURLSessionResponseDisposition))completion {
    if (![response isKindOfClass:NSHTTPURLResponse.class] || response.expectedContentLength > (int64_t)kResponseLimit) {
        result.error = "Invalid or oversized HTTP response";
        completion(NSURLSessionResponseCancel);
        return;
    }
    NSHTTPURLResponse* http = (NSHTTPURLResponse*)response;
    result.status = (int)http.statusCode;
    result.headersMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    result.cacheControl = [[http valueForHTTPHeaderField:@"Cache-Control"] UTF8String] ?: "";
    result.age = [[http valueForHTTPHeaderField:@"Age"] UTF8String] ?: "";
    result.cacheStatus = [[http valueForHTTPHeaderField:@"X-Vercel-Cache"] UTF8String] ?: "";
    completion(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession*)session dataTask:(NSURLSessionDataTask*)task didReceiveData:(NSData*)data {
    if (data.length > kResponseLimit - self.data.length) {
        result.error = "HTTP response exceeds 16 MiB";
        [task cancel];
    } else {
        [self.data appendData:data];
    }
}
- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task
    willPerformHTTPRedirection:(NSHTTPURLResponse*)response newRequest:(NSURLRequest*)request
    completionHandler:(void (^)(NSURLRequest*))completion {
    // Keep callers' host/CDN allowlists effective; never follow a redirect implicitly.
    completion(nil);
}
- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task didCompleteWithError:(NSError*)error {
    if (error || !result.error.empty()) {
        result.status = 0;
        if (result.error.empty()) result.error = error.localizedDescription.UTF8String ?: "HTTP request failed";
    } else if (self.data.length) {
        result.body.assign((const char*)self.data.bytes, self.data.length);
    }
    dispatch_semaphore_signal(self.finished);
}
@end

namespace ssc {
HttpResponse httpRequestImpl(const std::string& host, unsigned short port, const std::string& path,
    const std::string& method, const std::string& body, const std::string& contentType,
    int timeoutSeconds, const std::atomic<bool>* cancel) {
    @autoreleasepool {
        HttpResponse failure;
        if (cancel && cancel->load()) { failure.error = "Cancelled"; return failure; }
        if ((port != 443 && port != 80) || host.empty() || path.empty() || path[0] != '/') {
            failure.error = "Invalid HTTP destination"; return failure;
        }
        NSString* address = [NSString stringWithFormat:@"%s://%s:%u%s", port == 443 ? "https" : "http",
            host.c_str(), port, path.c_str()];
        NSURL* url = [NSURL URLWithString:address];
        if (!url || ![url.host isEqualToString:[NSString stringWithUTF8String:host.c_str()]] || url.user || url.password) {
            failure.error = "Invalid HTTP URL"; return failure;
        }
        const int seconds = timeoutSeconds > 0 ? timeoutSeconds : 20;
        NSMutableURLRequest* request = [NSMutableURLRequest requestWithURL:url
            cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:seconds];
        request.HTTPMethod = [NSString stringWithUTF8String:method.c_str()];
        [request setValue:@"24seven.fm-covers/1.0 (macOS; Apple)" forHTTPHeaderField:@"User-Agent"];
        if (!body.empty()) request.HTTPBody = [NSData dataWithBytes:body.data() length:body.size()];
        if (!contentType.empty()) [request setValue:[NSString stringWithUTF8String:contentType.c_str()] forHTTPHeaderField:@"Content-Type"];
        NSURLSessionConfiguration* config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
        config.timeoutIntervalForResource = seconds;
        config.HTTPCookieStorage = nil;
        config.URLCredentialStorage = nil;
        SSCHttpDelegate* delegate = [SSCHttpDelegate new];
        NSURLSession* session = [NSURLSession sessionWithConfiguration:config delegate:delegate delegateQueue:nil];
        NSURLSessionDataTask* task = [session dataTaskWithRequest:request];
        [task resume];
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
        while (dispatch_semaphore_wait(delegate.finished, dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC))) {
            if ((cancel && cancel->load()) || std::chrono::steady_clock::now() >= deadline) {
                [session invalidateAndCancel];
                // Delegate owns its state until completion; no stack addresses escape.
                failure.error = cancel && cancel->load() ? "Cancelled" : "Request timed out";
                return failure;
            }
        }
        [session finishTasksAndInvalidate];
        return delegate->result;
    }
}
} // namespace ssc
