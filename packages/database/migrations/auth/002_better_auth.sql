-- Generated from the Better Auth configuration in apps/server/src/auth.ts.
--
-- Regenerate this file from Better Auth's migration API when its models or
-- plugins change, then review the schema-only diff. Application constraints,
-- triggers, grants, and data changes do not belong in this file.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', true);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: jwks; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.jwks (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "expiresAt" timestamp with time zone,
    alg text,
    crv text
);


--
-- Name: oauthAccessToken; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."oauthAccessToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text,
    "referenceId" text,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "refreshId" text,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    confirmation jsonb,
    scopes jsonb NOT NULL
);


--
-- Name: oauthClient; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."oauthClient" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "clientSecret" text,
    disabled boolean,
    "skipConsent" boolean,
    "enableEndSession" boolean,
    "subjectType" text,
    scopes jsonb,
    "userId" text,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    name text,
    uri text,
    icon text,
    contacts jsonb,
    tos text,
    policy text,
    "softwareId" text,
    "softwareVersion" text,
    "softwareStatement" text,
    "redirectUris" jsonb NOT NULL,
    "postLogoutRedirectUris" jsonb,
    "backchannelLogoutUri" text,
    "backchannelLogoutSessionRequired" boolean,
    "tokenEndpointAuthMethod" text,
    jwks text,
    "jwksUri" text,
    "grantTypes" jsonb,
    "responseTypes" jsonb,
    public boolean,
    type text,
    "requirePKCE" boolean,
    "dpopBoundAccessTokens" boolean,
    "referenceId" text,
    metadata jsonb
);


--
-- Name: oauthClientAssertion; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."oauthClientAssertion" (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL
);


--
-- Name: oauthClientResource; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."oauthClientResource" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "resourceId" text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp with time zone
);


--
-- Name: oauthConsent; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."oauthConsent" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "userId" text,
    "referenceId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    scopes jsonb NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: oauthRefreshToken; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."oauthRefreshToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text NOT NULL,
    "referenceId" text,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    "rotatedAt" timestamp with time zone,
    "rotationReplayResponse" text,
    "rotationReplayExpiresAt" timestamp with time zone,
    "authTime" timestamp with time zone,
    confirmation jsonb,
    scopes jsonb NOT NULL
);


--
-- Name: oauthResource; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."oauthResource" (
    id text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    "accessTokenTtl" integer,
    "refreshTokenTtl" integer,
    "signingAlgorithm" text,
    "signingKeyId" text,
    "allowedScopes" jsonb,
    "customClaims" jsonb,
    "dpopBoundAccessTokensRequired" boolean,
    disabled boolean,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    "policyVersion" integer,
    metadata jsonb
);


--
-- Name: passkey; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.passkey (
    id text NOT NULL,
    name text,
    "publicKey" text NOT NULL,
    "userId" text NOT NULL,
    "credentialID" text NOT NULL,
    counter integer NOT NULL,
    "deviceType" text NOT NULL,
    "backedUp" boolean NOT NULL,
    transports text,
    "createdAt" timestamp with time zone,
    aaguid text
);


--
-- Name: session; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);


--
-- Name: user; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: jwks jwks_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);


--
-- Name: oauthAccessToken oauthAccessToken_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthAccessToken oauthAccessToken_token_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_token_key" UNIQUE (token);


--
-- Name: oauthClientAssertion oauthClientAssertion_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClientAssertion"
    ADD CONSTRAINT "oauthClientAssertion_pkey" PRIMARY KEY (id);


--
-- Name: oauthClientResource oauthClientResource_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_pkey" PRIMARY KEY (id);


--
-- Name: oauthClient oauthClient_clientId_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_clientId_key" UNIQUE ("clientId");


--
-- Name: oauthClient oauthClient_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_pkey" PRIMARY KEY (id);


--
-- Name: oauthConsent oauthConsent_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshToken oauthRefreshToken_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshToken oauthRefreshToken_token_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_token_key" UNIQUE (token);


--
-- Name: oauthResource oauthResource_identifier_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthResource"
    ADD CONSTRAINT "oauthResource_identifier_key" UNIQUE (identifier);


--
-- Name: oauthResource oauthResource_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthResource"
    ADD CONSTRAINT "oauthResource_pkey" PRIMARY KEY (id);


--
-- Name: passkey passkey_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.passkey
    ADD CONSTRAINT passkey_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "account_userId_idx" ON auth.account USING btree ("userId");


--
-- Name: oauthAccessToken_authorizationCodeId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON auth."oauthAccessToken" USING btree ("authorizationCodeId");


--
-- Name: oauthAccessToken_clientId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_clientId_idx" ON auth."oauthAccessToken" USING btree ("clientId");


--
-- Name: oauthAccessToken_refreshId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_refreshId_idx" ON auth."oauthAccessToken" USING btree ("refreshId");


--
-- Name: oauthAccessToken_sessionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_sessionId_idx" ON auth."oauthAccessToken" USING btree ("sessionId");


--
-- Name: oauthAccessToken_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_userId_idx" ON auth."oauthAccessToken" USING btree ("userId");


--
-- Name: oauthClientResource_clientId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthClientResource_clientId_idx" ON auth."oauthClientResource" USING btree ("clientId");


--
-- Name: oauthClientResource_resourceId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthClientResource_resourceId_idx" ON auth."oauthClientResource" USING btree ("resourceId");


--
-- Name: oauthClient_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthClient_userId_idx" ON auth."oauthClient" USING btree ("userId");


--
-- Name: oauthConsent_clientId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthConsent_clientId_idx" ON auth."oauthConsent" USING btree ("clientId");


--
-- Name: oauthConsent_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthConsent_userId_idx" ON auth."oauthConsent" USING btree ("userId");


--
-- Name: oauthRefreshToken_authorizationCodeId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON auth."oauthRefreshToken" USING btree ("authorizationCodeId");


--
-- Name: oauthRefreshToken_clientId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthRefreshToken_clientId_idx" ON auth."oauthRefreshToken" USING btree ("clientId");


--
-- Name: oauthRefreshToken_sessionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthRefreshToken_sessionId_idx" ON auth."oauthRefreshToken" USING btree ("sessionId");


--
-- Name: oauthRefreshToken_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthRefreshToken_userId_idx" ON auth."oauthRefreshToken" USING btree ("userId");


--
-- Name: passkey_credentialID_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "passkey_credentialID_idx" ON auth.passkey USING btree ("credentialID");


--
-- Name: passkey_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "passkey_userId_idx" ON auth.passkey USING btree ("userId");


--
-- Name: session_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "session_userId_idx" ON auth.session USING btree ("userId");


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX verification_identifier_idx ON auth.verification USING btree (identifier);


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_clientId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_refreshId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES auth."oauthRefreshToken"(id) ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_sessionId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth.session(id) ON DELETE SET NULL;


--
-- Name: oauthAccessToken oauthAccessToken_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: oauthClientResource oauthClientResource_clientId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;


--
-- Name: oauthClientResource oauthClientResource_resourceId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES auth."oauthResource"(identifier) ON DELETE CASCADE;


--
-- Name: oauthClient oauthClient_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: oauthConsent oauthConsent_clientId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;


--
-- Name: oauthConsent oauthConsent_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: oauthRefreshToken oauthRefreshToken_clientId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;


--
-- Name: oauthRefreshToken oauthRefreshToken_sessionId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth.session(id) ON DELETE SET NULL;


--
-- Name: oauthRefreshToken oauthRefreshToken_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: passkey passkey_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.passkey
    ADD CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;

-- Restore the migrator path before it records this migration.
SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', true);
