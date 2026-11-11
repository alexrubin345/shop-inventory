# Shop Inventory

Tap a phone to a bin's NFC tag, see what's in it, and add or take parts. Everyone in the shop shares one live inventory, every change is logged with who made it, and a daily alert lists what needs reordering.

- **Website:** static files hosted free on GitHub Pages.
- **Database and sign-in:** Supabase (free tier). Only emails on the member list can see or change anything.
- **Alerts:** a scheduled GitHub Action sends a push notification through the free ntfy app.

## How it fits together

Each NFC sticker holds a link like `https://you.github.io/shop-inventory/?bin=A-014`. Tags point at **bins**, and bins point at **parts**, so you can move a part to a different bin without rewriting any tags. A part can live in more than one bin; its count is the total.

Counts only change through two database functions (`adjust_stock` and `set_stock`). Two people tapping at the same moment can't overwrite each other, and every change lands in the activity log.

## Setup

### 1. Create the Supabase project

1. Sign up at supabase.com and create a new project (the free plan is fine).
2. Open **SQL Editor**, paste in all of `supabase/schema.sql`, and run it.
3. Make yourself the first admin. In the SQL editor, run this with your email:
   ```sql
   insert into public.members (email, role) values ('you@example.com', 'admin');
   ```

### 2. Turn on sign-in codes

The app signs people in with a 6-digit code emailed to them. They stay signed in on that phone afterward.

1. Go to **Authentication > Sign In / Providers** and make sure **Email** is enabled.
2. Go to **Authentication > Emails**. Edit both the **Magic link** and **Confirm signup** templates (first-time sign-ins use the second one) so the message includes the code, for example:
   ```html
   <h2>Your shop inventory sign-in code</h2>
   <p>Enter this code: <strong>{{ .Token }}</strong></p>
   <p>Or <a href="{{ .ConfirmationURL }}">sign in with this link</a>.</p>
   ```
3. After step 4 below, go to **Authentication > URL Configuration**. Set **Site URL** to your GitHub Pages address, and add `https://YOUR-USERNAME.github.io/shop-inventory/**` under **Redirect URLs**.

Supabase's built-in email sender is limited to a handful of emails per hour. That's fine for a small team since each person signs in once per device. If you hit the limit, add a custom SMTP provider under **Authentication > Emails > SMTP Settings**.

### 3. Connect the app to Supabase

Copy the **Project URL** (Project Settings > Data API, or the **Connect** button) and the **publishable** key (Project Settings > API Keys, starts with `sb_publishable_`). Paste both into `config.js`.

These two values are safe to publish. Never put the **secret** key (`sb_secret_...`) in `config.js`.

### 4. Publish on GitHub Pages

1. Create a GitHub repository (for example `shop-inventory`) and upload these files.
2. Go to **Settings > Pages**, set **Source** to "Deploy from a branch", and choose `main` and `/ (root)`.
3. After a minute the site is live at `https://YOUR-USERNAME.github.io/shop-inventory/`. Open it, sign in, and add your first part.

### 5. Set up bins and write the tags

1. In the app, open **Bins > Add bins** and create a numbered run, such as A-001 to A-040.
2. Next to each bin, tap **Copy tag link**. **Download tag list** gives you every link in a spreadsheet if you're doing a lot of them.
3. In the NFC Tools app (iOS or Android), choose **Write > Add a record > URL**, paste the link, then hold the phone to the sticker.
4. Scan the tag. The first scan of an empty bin asks which part goes in it.

Use NTAG213 or NTAG215 stickers. On metal bins or shelving, use stickers sold as "on-metal" or "anti-metal", since ordinary tags won't read there. Scanning a tag that has no bin yet offers to set one up, so you can also just write tags first and register them by scanning.

### 6. Turn on low-stock alerts (optional)

1. Install the **ntfy** app on your phone and subscribe to a topic with a long, hard-to-guess name, like `shop-stock-7fk29xq`. Anyone who knows the name can read it.
2. In your repository, go to **Settings > Secrets and variables > Actions** and add these **secrets**:
   - `SUPABASE_URL`: your Project URL
   - `SUPABASE_SERVICE_KEY`: the **secret** key (`sb_secret_...`) from Project Settings > API Keys
   - `NTFY_TOPIC`: your topic name
3. On the **Variables** tab of the same page, add `APP_URL` with your GitHub Pages address, so tapping the alert opens the reorder list.
4. Go to **Actions > Low stock alert > Run workflow** to test it.

It runs daily at 7 AM Mountain time. Edit the `cron` line in `.github/workflows/low-stock-alert.yml` to change that. Nothing is sent when everything is stocked.

Two free-tier quirks: Supabase pauses projects that go a week with no activity, and the daily alert counts as activity, so it helps keep the database awake. GitHub turns off scheduled workflows in repositories with no commits for 60 days; if that happens, re-enable it from the Actions tab.

### 7. Add the rest of the shop

Open **Members** and add each person's email as an **Editor** or **Admin**.

- **Editors** can count, add and edit parts and bins.
- **Admins** can also delete parts and bins and manage the member list.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The web app |
| `config.js` | Your Supabase URL and public key |
| `supabase/schema.sql` | Tables, security rules and stock functions |
| `scripts/low-stock-alert.mjs` | Builds and sends the reorder alert |
| `.github/workflows/low-stock-alert.yml` | Runs the alert daily |
