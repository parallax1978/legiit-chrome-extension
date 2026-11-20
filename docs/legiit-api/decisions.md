# Legiit Lens API: decisions for the product owner

Your developers cannot answer these questions for you. Each question has a recommended answer.

**The fast way:** tell your developers "use the recommended answer for all". Then give them the four things at the end of this page, which only you can provide.

The numbers are the numbers of section 11 in the developer guide ([README.md](README.md)).

## Needed before the developers start

| # | Question | Why it matters | Recommended answer | Your answer |
| --- | --- | --- | --- | --- |
| 1 | What is the web address of the new API? | The address is built into the extension. After the extension is in the Chrome Web Store, a change makes Chrome switch the extension off for every user until they approve the new address | `https://api.legiit.com` | |
| 3 | A user sends a client brief to Command Center. What appears there? | The button in the extension is called "Open in Command Center", so the user expects to land on something | A new item of its own (a prospect) that shows the brief. When the user sends the same brief again, it replaces the first one | |
| 4 | A user sends a content analysis to the content editor. What appears there? | Your developers must know where to put it | A note on the business with two lists: "Only on this page" and "Missing points" | |
| 10 | A team member connects the extension. Which businesses can they save into? | It decides which businesses the extension offers to that person | Every business that this person may save into in Command Center: their own, and the ones shared with them | |

## Needed before each feature goes live

| # | Question | Why it matters | Recommended answer | Your answer |
| --- | --- | --- | --- | --- |
| 2 | Where does a user get the token (the key that they paste into the extension), and how long does it work? | Without a token nobody can connect | A "Legiit Lens" page in the settings of Command Center. A token works until the user revokes it | |
| 5 | Which plan gets which feature? | The extension shows a feature only to users whose plan includes it | Every paid plan gets all eight features. A free plan gets none | |
| 6 | Which AI model rewrites the summaries, and how much may one user use it? | Every use costs money, and the text goes to the company that runs the model | Start without it: the extension then writes its own summaries. Later: a model that Legiit already pays for, with 20 rewrites per user per day. The company that runs the model must agree in writing not to train on the text and not to keep it. The privacy policy must name that company | |
| 7 | Who keeps the "Industry Pulse" list (the dates of Google updates) up to date? | Without a person the list goes out of date | One named person. Start with a list that a developer loads once | |
| 9 | What are the pages for saved items in Command Center? | The extension shows a link to the page of each saved item | One page for each of the five kinds of item. Your developers choose the web addresses. Someone has to design the pages: the guide lists what each page must show at least | |

## Needed before launch

| # | Question | Why it matters | Recommended answer | Your answer |
| --- | --- | --- | --- | --- |
| 8 | How long does Legiit keep what users save? | The privacy policy must say it. Saved items can contain names and e-mail addresses of other people | As long as the account exists, and deleted with it. One person's contact details are removed on request | |
| 11 | Is there a test account for Google's reviewers? | Google may test the connection to Legiit before it approves the extension | Yes: one account with one business and a token | |
| 12 | Is there a test server for the developers? | They need it to test without touching real accounts | Yes, with its own web address, and without a password prompt in front of it | |
| 13 | Who at Legiit may open what users saved, and in which tools? | The privacy policy promises that people at Legiit do not read saved items | Nobody in normal work. Support sees that an item exists, not what is in it. Opening an item needs the user's consent, a security reason or a legal duty | |

## Four things only you can provide

1. **Access to the repository.** Give your developers read access to `parallax1978/legiit-chrome-extension` on GitHub. The guide alone is not enough: the test tools are in the repository.
2. **A contact.** Tell your developers who answers their questions about the extension.
3. **A date.** Tell them when you plan to submit the extension to the Chrome Web Store. The web address of the API (question 1) must be final by then.
4. **Sign-off.** The guide has a list called "Launch done" (section 1). When your developers say that it is complete, you confirm it.
