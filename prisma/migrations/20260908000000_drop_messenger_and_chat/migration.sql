-- Removes the Messenger bot, support-chat, and storefront widget tables.
DROP TABLE IF EXISTS "MessengerMessage";
DROP TABLE IF EXISTS "MessengerThread";
DROP TABLE IF EXISTS "LookupAttempt";
DROP TABLE IF EXISTS "AgentRateLimit";
DROP TABLE IF EXISTS "SupportChatJob";
DROP TABLE IF EXISTS "SupportChatMessage";
DROP TABLE IF EXISTS "SupportChatThread";
DROP TABLE IF EXISTS "WidgetConfig";
