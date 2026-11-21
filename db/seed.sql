-- WorkMail seed data (D1). Apply after db/schema.sql:
-- wrangler d1 execute <db> --file=db/seed.sql
-- Prices are INR paise (minor units). The enterprise row is INACTIVE with
-- price 0 until a platform admin sets its real price and activates it.
INSERT OR IGNORE INTO plan_catalog (id, name, monthly_price_minor, monthly_send_limit, storage_limit_bytes, features, is_active) VALUES
 ('free','Free',0,300,536870912,'{"mailboxes":2,"team":false}',1),
 ('pro','Pro',49900,5000,10737418240,'{"mailboxes":10,"team":true}',1),
 ('business','Business',149900,25000,53687091200,'{"mailboxes":50,"team":true}',1),
 ('enterprise','Enterprise',0,100000,107374182400,'{"mailboxes":200,"team":true}',0);
