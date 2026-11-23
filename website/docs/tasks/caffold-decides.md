# Caffold decides

**Caffold decides** is an approval mode Caffold adds to every agent. The agent
asks about everything, and the decision model you choose answers the routine
requests for you. Only the requests that need a person reach you.

## Set it up

1. Open **Settings → Decision Model**.
2. Choose **Jev**, a decision model from [TypeSafe](https://typesafe.ai), or
   **OpenAI**.
3. Enter that provider's API key and choose **Save key**. Caffold asks the model
   one test question and shows the answer under **Last check**.
4. Optionally, write **Extra rules** that add to the model's baseline or take
   away from it, and choose **Save extra rules**.
5. In a Task's Composer, choose **Caffold decides** in the **Permissions** menu.

Each model keeps its own key, so you can switch between them. Without a key for
the chosen model, **Caffold decides** stays in the menu and says what is
missing.

![Settings → Decision Model with Jev chosen and its key saved](../assets/screenshots/settings-decision-model-light-desktop.png#only-light)
![Settings → Decision Model with Jev chosen and its key saved](../assets/screenshots/settings-decision-model-dark-desktop.png#only-dark)

## How it works

With **Caffold decides**, the agent runs under whichever of its own modes asks
the most. Before a request is shown to you, Caffold asks the decision model one
question: does this request need a person?

- If the model finds no reason to ask you, Caffold allows the request once. The
  conversation records it with the model's answer, for example
  **Approved by Jev · 3% concern**.
- Otherwise the request comes to you as usual, and its card shows which model
  answered and how sure it is, for example **Jev · 80% sure this needs you**.

The decision model never refuses a request and never grants anything beyond
this one request. If it cannot answer within five seconds, or the call fails for
any reason, the request comes to you exactly as it would without it.

## What the decision model goes by

Its baseline is the standard of a coding agent's automatic permission mode.
What you said overrides that baseline, strongest first:

1. the last ten prompts you sent in this Task, a later one over an earlier one;
2. the extra rules in **Settings → Decision Model**.

You don't need special wording. The decision model reads your recent prompts
beside each request, so a prompt such as "Word edits like these are fine, just
approve them" is read against the next request that rewrites that Word file.
Work you ask for in a turn counts as allowed during that turn, and something
you allow or refuse counts until you say otherwise. Anything that should hold
for longer than your last ten prompts belongs in the extra rules.

## What the decision model sees

Choosing **Caffold decides** sends information to the chosen model's provider,
TypeSafe for Jev or OpenAI. For each approval request it sends the request as
the agent wrote it for you, with the agent's own title and reason; the Task's
working directory; your extra rules; and the last ten prompts you sent in the
Task, each marked with whether it belongs to the turn the request came from.

Under every other approval mode, nothing is sent to either provider. The keys,
the rules, and each Task's last ten prompts are stored on the host; see
[Data and privacy](../reference/data-and-privacy.md).
