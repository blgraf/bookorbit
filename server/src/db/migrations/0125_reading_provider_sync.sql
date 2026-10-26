CREATE TABLE "reading_provider_books" (
	"user_id" integer NOT NULL,
	"provider" varchar(20) NOT NULL,
	"book_id" integer NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"remote_id" varchar(255),
	"resource_id" varchar(255),
	"match_method" varchar(20),
	"last_local" jsonb,
	"last_remote" jsonb,
	"last_synced_at" timestamp with time zone,
	"error" text,
	"warning" text,
	"due_at" timestamp with time zone,
	"connection_version" integer DEFAULT 1 NOT NULL,
	"last_remote_read_id" varchar(255),
	"attempts" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"uncertain_write" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_provider_books_user_id_provider_book_id_pk" PRIMARY KEY("user_id","provider","book_id"),
	CONSTRAINT "reading_provider_book_provider_chk" CHECK ("reading_provider_books"."provider" in ('goodreads', 'pagebound'))
);
--> statement-breakpoint
CREATE TABLE "reading_provider_connections" (
	"user_id" integer NOT NULL,
	"provider" varchar(20) NOT NULL,
	"credentials_enc" text,
	"account_id" varchar(255),
	"enabled" boolean DEFAULT false NOT NULL,
	"reconnect_required" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"date_cursor_at" timestamp with time zone,
	"date_cursor_book_id" integer DEFAULT 0 NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"error" text,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"bulk_active" boolean DEFAULT false NOT NULL,
	"bulk_after_book_id" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_provider_connections_user_id_provider_pk" PRIMARY KEY("user_id","provider"),
	CONSTRAINT "reading_provider_connection_provider_chk" CHECK ("reading_provider_connections"."provider" in ('goodreads', 'pagebound'))
);
--> statement-breakpoint
ALTER TABLE "reading_provider_books" ADD CONSTRAINT "reading_provider_books_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_provider_books" ADD CONSTRAINT "reading_provider_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_provider_connections" ADD CONSTRAINT "reading_provider_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reading_provider_books_book_idx" ON "reading_provider_books" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "reading_provider_books_due_idx" ON "reading_provider_books" USING btree ("due_at","user_id","provider") WHERE "reading_provider_books"."due_at" is not null;--> statement-breakpoint
CREATE INDEX "ubs_user_updated_book_idx" ON "user_book_status" USING btree ("user_id","updated_at","book_id");