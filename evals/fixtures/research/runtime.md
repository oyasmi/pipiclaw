# Runtime facts

Pipiclaw uses DingTalk as its primary transport. It keeps current working state in session memory and durable channel facts in long-lived memory. Scheduled task dispatch first applies deterministic deadline, budget, and dependency governance; only eligible work is then sent to the model.
