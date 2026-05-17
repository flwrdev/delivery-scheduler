// Type declarations for Shopify Polaris web components used in customer account extensions.
// These allow TypeScript to accept s-* custom element tags in JSX without errors.

declare namespace JSX {
  interface IntrinsicElements {
    's-section': React.HTMLAttributes<HTMLElement> & { heading?: string };
    's-stack': React.HTMLAttributes<HTMLElement> & {
      direction?: 'block' | 'inline';
      gap?: string;
      'align-items'?: string;
    };
    's-text': React.HTMLAttributes<HTMLElement> & {
      color?: string;
      tone?: string;
      type?: string;
    };
    's-banner': React.HTMLAttributes<HTMLElement> & {
      tone?: string;
      heading?: string;
      dismissible?: boolean;
    };
    's-button': React.HTMLAttributes<HTMLElement> & {
      variant?: string;
      tone?: string;
      type?: string;
      slot?: string;
      loading?: boolean;
      disabled?: boolean;
      onClick?: (e: Event) => void;
    };
    's-text-field': React.HTMLAttributes<HTMLElement> & {
      label?: string;
      value?: string;
      placeholder?: string;
      error?: string;
      ref?: React.Ref<HTMLElement>;
      onInput?: (e: Event) => void;
    };
    's-date-field': Omit<React.HTMLAttributes<HTMLElement>, 'onChange'> & {
      label?: string;
      value?: string;
      error?: string;
      required?: boolean;
      allow?: string;
      disabled?: boolean;
      onChange?: (e: React.FormEvent<HTMLElement>) => void;
    };
    's-select': Omit<React.HTMLAttributes<HTMLElement>, 'onChange'> & {
      label?: string;
      value?: string;
      error?: string;
      ref?: React.Ref<HTMLElement>;
      onChange?: (e: React.FormEvent<HTMLElement>) => void;
    };
    's-option': React.HTMLAttributes<HTMLElement> & {
      key?: React.Key;
      value?: string;
      disabled?: boolean;
    };
    's-customer-account-action': React.HTMLAttributes<HTMLElement> & {
      heading?: string;
    };
    's-badge': React.HTMLAttributes<HTMLElement> & {
      tone?: 'auto' | 'neutral' | 'critical';
    };
  }
}
