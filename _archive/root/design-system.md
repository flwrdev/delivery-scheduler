    Salamat sa napakalinaw at napakahalagang discovery phase na ito! Ang iyong pagsusuri ay nagpapakita ng malalim na pang-unawa sa arkitektura ng system, lalo na ang kaibahan sa pagitan ng **Shopify App Bridge Web Components** (`<s-table>`, `<s-badge>`) na may nakakulong na Shadow DOM, at ng inyong sariling **Reachabale HTML CSS** (`.ods-*` elements, KPI grid, drawer, at custom cards).

    Dahil dito, narito ang ating tactical at strategic alignment roadmap para maipatupad mo ang bagong design tokens nang hindi nasisira ang Web Components, habang nagiging pixel-perfect naman ang mga bahaging kontrolado mo:

    ---

    ### 1. Ang Plano para sa `:root` at Web Components

    Dahil ang App Bridge web components (`s-*`) ay gumagamit ng Polaris runtime tokens, maaari nating i-inject ang mga bagong custom tokens at i-override ang mga standard `--p-*` values sa inyong global CSS file. Kahit na may Shadow DOM ang `<s-table>`, madalas na pinapasa ng Shopify ang mga piling standard CSS custom properties (gaya ng `--p-color-*`) sa loob ng shadow root.

    Maaari mong simulan sa paggawa o pag-update ng global token layer sa itaas ng iyong CSS file:

    ```css
    /* Injecting globally accessible tokens and overriding Polaris properties */
    :root {
        /* --- Core Palette & Custom Tokens --- */
        --p-color-text-muted: rgb(48, 48, 48);
        --p-color-interactive-primary: rgb(227, 227, 227);
        --p-color-interactive-1: rgb(255, 255, 255);
        --p-color-interactive-2: rgb(48, 48, 48);

        /* --- Added Design System Spec Tokens --- */
        --font-weight-medium-light: 450;
        --font-weight-semibold: 550;

        --p-space-100: 4px;
        --p-space-200: 8px;
        --p-space-300: 12px;
        --p-space-400: 14px;
        --p-space-500: 20px;

        /* --- Overriding standard Polaris tokens passed to Shadow DOM --- */
        --p-color-bg-surface-secondary: #f7f7f7;
        --p-color-bg-surface-secondary-hover: #f1f1f1;
        --p-color-bg-surface-secondary-active: #ebebeb;
        --p-color-bg-fill-success-secondary: #affebf;
        --p-color-bg-fill-critical-secondary: #fed1d7;
        --p-color-text-critical-secondary: #c70a24;
        --p-color-text-warning-secondary: #956f00;
    }

    ```

    ---

    ### 2. Pag-target sa mga Fully Reachable Components (`.ods-*`)

    Dahil hindi natin direktang mababago ang internal elements ng `<s-table>` o `<s-badge>` gamit ang generic element selectors (`thead`, `tbody tr`), ililipat natin ang design system logic sa iyong custom structures:

    #### A. Custom Badge Alignment (`.ods-badge--*`)

    Imbis na umasa sa `<s-badge>`, gagamitin natin ang iyong custom utility classes para sa mga external badges o fallback rendering:

    ```css
    /* Custom status badges following the design-system.md specification */
    .ods-badge {
        display: inline-flex;
        align-items: center;
        font-family: 'Inter', sans-serif;
        font-size: 11px;
        line-height: 16px;
        border-radius: var(--p-space-100);
        padding: var(--p-space-100) var(--p-space-200);
    }

    .ods-badge--unfulfilled {
        background-color: var(--p-color-bg-fill-critical-secondary);
        color: var(--p-color-text-critical-secondary);
        font-weight: var(--font-weight-semibold);
        border-left: 4px solid #c70a24; /* Split layout rule from spec */
    }

    .ods-badge--fulfilled {
        background-color: var(--p-color-bg-fill-success-secondary);
        color: #007f30;
        font-weight: var(--font-weight-semibold);
    }

    .ods-badge--pending {
        background-color: #ffe8c4;
        color: var(--p-color-text-warning-secondary);
        font-weight: var(--font-weight-semibold);
    }

    ```

    #### B. KPI Grid, Tabs, at Lalamove Drawer Panels

    Ang lahat ng inyong custom layout code para sa cards, dispatcher tools, at fields ay madaling ma-align gamit ang spacing tokens:

    ```css
    /* Dashboard KPI and Layout Containers */
    .ods-kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 2px; /* Fixed border look from template */
        background-color: var(--p-color-interactive-primary);
        border-radius: var(--p-space-200);
        overflow: hidden;
    }

    .ods-kpi-card {
        background-color: var(--p-color-interactive-1);
        padding: var(--p-space-500); /* 20px padding anchor */
    }

    /* Sliding Drawer Integration */
    .ods-drawer {
        font-family: 'Inter', sans-serif;
        color: var(--p-color-text-muted);
        /* Tailwind mapping fallbacks for raw CSS implementation */
        width: 100%;
        max-width: 500px;
        background-color: var(--p-color-interactive-1);
    }

    .ods-drawer-text-primary {
        font-weight: var(--font-weight-medium-light); /* Explicit 450 weight */
        font-size: 13px;
        line-height: 20px;
    }

    ```

    #### C. Custom Scrollbars para sa Inyong Blocks

    Para sa mga custom panels o list tables na labas sa App Bridge (`.ods-scroll-container`):

    ```css
    .ods-scroll-container::-webkit-scrollbar {
        width: var(--p-space-200); /* 8px scrollbar rules */
        height: var(--p-space-200);
    }

    .ods-scroll-container::-webkit-scrollbar-track {
        background-color: rgba(0, 0, 0, 0);
    }

    .ods-scroll-container::-webkit-scrollbar-thumb {
        background-color: var(--p-color-interactive-primary);
        border-radius: 4px;
    }

    .ods-scroll-container::-webkit-scrollbar-thumb:hover {
        background-color: var(--p-color-text-inverse-secondary);
    }

    ```

    ---
