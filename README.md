# My Proxy Server

## Overview

Đây là một proxy HTTP nhỏ viết bằng Express, dùng danh sách đen (blacklist) dạng substring (không phân biệt hoa thường) nằm trong thư mục cấu hình. Proxy hỗ trợ cả HTTP proxying và HTTP CONNECT (dùng để tunnel HTTPS). Server có endpoint `/health` trả trạng thái và phiên bản danh sách đen.

## How to run

Chạy file đã biên dịch và truyền đường dẫn tới thư mục cấu hình làm tham số đầu tiên:

node <đường dẫn tới file dist/proxy-server.js> <đường dẫn tới thư mục config>

Ví dụ (từ thư mục gốc dự án sau khi `npm run build`):

```javascript
node dist/proxy-server.js config
```

## How to integrate

Khi muốn tích hợp vào cấu hình MCP (ví dụ trong `mcp.json` hoặc một file cấu hình khởi chạy Chrome), chỉ cần chỉ định proxy server là địa chỉ host:port nơi proxy đang chạy. Ví dụ `mcp.json` có thể chứa trường cấu hình tương tự (dưới đây là ví dụ minh họa):

```json
{
  "proxyServer": "localhost:8080"
}
```

Hoặc khi khởi chạy Chrome/MCP trực tiếp, thêm flag tương ứng:

```json
{
  "servers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--proxyServer=http://localhost:8080"
      ]
    }
  },
  "inputs": []
}
```

## Blacklist (cú pháp)

Tệp `blacklist.txt` nằm trong thư mục cấu hình (`<config-dir>/blacklist.txt`). Quy tắc:

- Một mục trên một dòng.
- So sánh theo substring, không phân biệt hoa thường (ví dụ `example.com` sẽ khớp `sub.example.com`).
- Các dòng rỗng sẽ bị bỏ qua.
- Các dòng bắt đầu bằng `#` được xem là comment và sẽ bị bỏ qua.

Ví dụ `config/blacklist.txt`:

```
# chặn domain ví dụ
example.com

# chặn loopback
127.0.0.1
```
