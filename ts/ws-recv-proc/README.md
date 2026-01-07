long running process that:
- subscribes to a websocket
- on receive message, transforms, and pushes to PubSub

hosted in an express harnes, which exposes /healthz & /readyz endpoints
