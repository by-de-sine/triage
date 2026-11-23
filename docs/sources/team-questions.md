# Team questions

A sender publishes a quiz as an assigned draft in a private organization Project. The recipient opens the quiz in Triage, selects answers, adds notes and submits. Triage saves a second draft under the recipient's GitHub account and gives them a receipt. When the sender's Triage reads the response, it alerts them and links to the answers.

## Send questions

The SineTheta publisher ships with the `question-form` skill in the private `engineering@sinetheta` plugin. Install or update the plugin, then ask your agent to "send a questionnaire through Triage" and give it the Project URL, the recipient's GitHub login and the questions. The agent previews the destination and questions for your approval before publishing. [Plugin installation](https://github.com/BY-DE-SINE/agent-skills/blob/main/docs/INSTALL.md)

To send from a terminal, use Python 3 and the publisher in a checkout of the companion repository. Prepare the form JSON using the schema and run the preview under your own GitHub CLI login. The publisher adds the metadata Triage needs to recognize the assigned draft. [Form schema](https://github.com/BY-DE-SINE/agent-skills/blob/main/plugins/engineering/skills/question-form/references/schema.md)

```sh
publisher=plugins/engineering/skills/question-form/scripts/publish_form.py
python3 "$publisher" preview questions.json \
  --owner example-org --project 7 --recipient example-user --receipt send.json
python3 "$publisher" send send.json
```

Run `send` after reviewing the preview. Keep the receipt and its `.attempted` file together so a retry can look up the previous send.

## Connect Triage to the Project

Each participant needs Node 24 or newer, a Triage checkout, and GitHub CLI signed in under their own account. Both accounts need Write access to the private Project and the `project` scope for GitHub CLI OAuth. Project readers can see every question and answer. Project writers can edit drafts.

```sh
gh api user --jq .login
gh auth refresh -h github.com -s project
```

Use the owner and number from the Project URL. For example, `https://github.com/orgs/example-org/projects/7` becomes `example-org/7`. To run a separate test instance, start from the Triage checkout and give it its own settings, port and SQLite file.

```sh
touch .env
TRIAGE_ENV="$PWD/.env" TRIAGE_DB="$PWD/questions.db" TRIAGE_PORT=3317 \
  TRIAGE_GITHUB=off TRIAGE_QUESTIONS_PROJECT=example-org/7 node server.js
```

Open **http://127.0.0.1:3317** if the process runs on your computer. For a remote process, forward that port from your computer using `ssh -L 3317:127.0.0.1:3317 your-server`, then open the same address.

## Source settings

`TRIAGE_QUESTIONS_PROJECT=OWNER/NUMBER` enables the source. `TRIAGE_QUESTIONS=off` disables it, and `TRIAGE_QUESTIONS=fake` runs it with sample data. The source uses `GITHUB_TOKEN` or the account signed in through GitHub CLI. It runs independently of the GitHub notifications source.

Triage places assigned quizzes in the recipient's queue under the `question_assigned` rule. A new response to the sender's quiz matches `question_reply`, which interrupts by default. On its first successful scan, Triage indexes existing replies quietly. Reuse the same SQLite database across restarts to receive replies submitted while Triage was offline.

To get Slack alerts for new assignments, enable Slack delivery on the recipient's instance and allow `questions:question_assigned`. If `TRIAGE_INTERRUPT` is unset, use `TRIAGE_INTERRUPT=+questions:question_assigned` to add the rule to the defaults. If you already use a custom rule list, add `questions:question_assigned` in the same style as that list. The alert links to the GitHub draft. Open **Answer questions** in Triage to fill it out. [Interrupt settings](../interrupts.md)

## Check a round trip

1. Start the sender's instance and let its first Project scan finish. The first scan establishes which replies already existed.
2. [Send a quiz](#send-questions) to the recipient's GitHub login. On the recipient's instance, open the item in the queue and fill out the form. Add a recognizable note to one answer.
3. Select **Submit answers**, then open the receipt. Check that the response draft shows the note and was created by the recipient's account.
4. On the sender's instance, check the response item and follow its link. The delivery log records what Triage did with the alert under the sender's [interrupt settings](../interrupts.md). Restart with the same database and check that the response produces no new alert.

If the question does not appear, check the configured Project number, your GitHub login, the assignment and the source's last successful poll in `/api/sources`. A Project permission failure calls for checking both the account's Project access and its token's permissions.

If GitHub fails to confirm a submission, use **Submit answers** again to look for the receipt. Triage keeps your in-progress answers in the browser tab and checks GitHub for the previous submission before it can create another response.
