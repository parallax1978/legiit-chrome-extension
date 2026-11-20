# What Chrome really sent

The guide says which headers arrive at the server and when Chrome sends a preflight. This file is the evidence: requests recorded on a plain HTTP listener that stood in for the API, sent by a production build of the extension in Chrome 153 on Linux. Nothing here has to be built; it is for firewall rules and for doubts.

Header names are shown as the listener received them (lower case). The token was `demo-token`.

## Normal case: the API host is one of the extension's host permissions

No preflight is sent. 9 requests were recorded in two runs, none of them `OPTIONS`.

A read:

```http
GET /v1/session HTTP/1.1
host: localhost:8787
connection: keep-alive
pragma: no-cache
cache-control: no-cache
sec-ch-ua-platform: "Linux"
authorization: Bearer demo-token
user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36
accept: application/json
sec-ch-ua: "Chromium";v="153", "Not_A Brand";v="8"
x-legiit-client: legiit-lens/0.1.0
sec-ch-ua-mobile: ?0
sec-fetch-site: none
sec-fetch-mode: cors
sec-fetch-dest: empty
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
```

A save:

```http
POST /v1/businesses/biz_brightpath/competitors HTTP/1.1
host: localhost:8787
connection: keep-alive
content-length: 65
pragma: no-cache
cache-control: no-cache
sec-ch-ua-platform: "Linux"
authorization: Bearer demo-token
idempotency-key: 527009b4-2cbb-4648-b251-2f48e9a26657
sec-ch-ua: "Chromium";v="153", "Not_A Brand";v="8"
x-legiit-client: legiit-lens/0.1.0
sec-ch-ua-mobile: ?0
user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36
accept: application/json
content-type: application/json
origin: chrome-extension://<the 32 letters of the extension id>
sec-fetch-site: none
sec-fetch-mode: cors
sec-fetch-dest: empty
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9

(a JSON body of 65 bytes)
```

A read carries no `Origin`; a save does. Neither carries a cookie or a `Referer`.

## The user has switched off the extension's access to the host

Chrome then treats every request like a web page's: a preflight first, then the request, now with `Origin` also on a read. Recorded against a listener that sent the CORS headers of the guide: 8 requests, 4 of them preflights, and everything worked.

The preflight before a read:

```http
OPTIONS /v1/session HTTP/1.1
host: localhost:8787
connection: keep-alive
pragma: no-cache
cache-control: no-cache
accept: */*
access-control-request-method: GET
access-control-request-headers: authorization,x-legiit-client
origin: chrome-extension://<the 32 letters of the extension id>
user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36
sec-fetch-mode: cors
sec-fetch-site: cross-site
sec-fetch-dest: empty
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
```

The read that followed:

```http
GET /v1/session HTTP/1.1
host: localhost:8787
connection: keep-alive
pragma: no-cache
cache-control: no-cache
sec-ch-ua-platform: "Linux"
authorization: Bearer demo-token
user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36
accept: application/json
sec-ch-ua: "Chromium";v="153", "Not_A Brand";v="8"
x-legiit-client: legiit-lens/0.1.0
sec-ch-ua-mobile: ?0
origin: chrome-extension://<the 32 letters of the extension id>
sec-fetch-site: cross-site
sec-fetch-mode: cors
sec-fetch-dest: empty
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
```

The preflight before a save:

```http
OPTIONS /v1/businesses/biz_brightpath/competitors HTTP/1.1
host: localhost:8787
connection: keep-alive
pragma: no-cache
cache-control: no-cache
accept: */*
access-control-request-method: POST
access-control-request-headers: authorization,content-type,idempotency-key,x-legiit-client
origin: chrome-extension://<the 32 letters of the extension id>
user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36
sec-fetch-mode: cors
sec-fetch-site: cross-site
sec-fetch-dest: empty
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
```

The save that followed:

```http
POST /v1/businesses/biz_brightpath/competitors HTTP/1.1
host: localhost:8787
connection: keep-alive
content-length: 40
pragma: no-cache
cache-control: no-cache
sec-ch-ua-platform: "Linux"
authorization: Bearer demo-token
idempotency-key: 2d1d45e5-04cc-4333-8ac7-2f5845458548
sec-ch-ua: "Chromium";v="153", "Not_A Brand";v="8"
x-legiit-client: legiit-lens/0.1.0
sec-ch-ua-mobile: ?0
user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36
accept: application/json
content-type: application/json
origin: chrome-extension://<the 32 letters of the extension id>
sec-fetch-site: cross-site
sec-fetch-mode: cors
sec-fetch-dest: empty
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9

(a JSON body of 40 bytes)
```

The preflights ask for `authorization`, `x-legiit-client` and, before a save, `content-type` and `idempotency-key`. They do not ask for `cache-control` or `pragma`, although every request carries them: Chrome adds those two by itself.

## The same, against a listener without CORS headers

1 request was recorded: the preflight for `GET /v1/session`. Chrome did not send the read itself, and the extension showed "Could not reach Legiit: Failed to fetch". This is why the guide asks for the CORS headers as a safety net.
