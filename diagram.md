```mermaid
flowchart TB
C[Customer] --> UI[Customer Account UI]
UI --> API[Shopify API]
API --> META[Metafields]
META --> ADMIN[Admin Action]
ADMIN --> META
META --> UI
```
