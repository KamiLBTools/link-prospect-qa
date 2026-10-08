"""
Pass / fail from Jev's answers to the reviewer's own rejection reasons.

Reads eval/compare/sites.csv (written by `npm run compare -- --jev-signals`),
trains a logistic regression on the train split, and picks the fail cut-off on
the train split alone: the loosest one at which, in cross-validation, at least
TARGET of the Sites it fails are really bad. The test split is scored once, at
that cut-off, and written to eval/compare/signals-predictions.csv.

Needs scikit-learn and pandas:  pip install scikit-learn pandas
"""

import warnings

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")
np.seterr(all="ignore")

SITES = "eval/compare/sites.csv"
OUT = "eval/compare/signals-predictions.csv"
TARGET = 0.85

sites = pd.read_csv(SITES)
SIGNALS = [c for c in sites.columns if c.startswith("sig_")]
sites["fail"] = sites["human"].isin(["bad", "manipulation"]).astype(int)
sites["log_traffic"] = np.log1p(sites["traffic"].clip(lower=0))
sites["log_keywords"] = np.log1p(sites["keywords"].fillna(0).clip(lower=0))

train = sites[sites["split"] != "test"]
test = sites[sites["split"] == "test"]
folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)


def model():
    return make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000, C=0.5, class_weight="balanced"))


def fail_cutoff(p_fail, truth):
    """The lowest P(fail) cut-off whose fails are at least TARGET right, or None."""
    for cut in np.arange(0.30, 0.99, 0.01):
        failed = p_fail >= cut
        if failed.sum() >= 5 and truth[failed].mean() >= TARGET:
            return cut
    return None


def report(name, columns):
    X_train = train[columns].fillna(train[columns].median())
    X_test = test[columns].fillna(train[columns].median())
    oof = cross_val_predict(model(), X_train, train["fail"], cv=folds, method="predict_proba")[:, 1]
    cut = fail_cutoff(oof, train["fail"].to_numpy())
    fitted = model().fit(X_train, train["fail"])
    p = fitted.predict_proba(X_test)[:, 1]
    auc = roc_auc_score(test["fail"], p)
    bad = int(test["fail"].sum())
    if cut is None:
        print(f"  {name:32s} AUC {auc:.2f}   no cut-off reaches {TARGET:.0%} on train")
        return fitted, None, p
    failed = p >= cut
    right = int(test.loc[failed, "fail"].sum())
    passed = ~failed
    print(
        f"  {name:32s} AUC {auc:.2f}   cut {cut:.2f}: fails {failed.sum():3d}, "
        f"{right / max(1, failed.sum()):.0%} right, catches {right}/{bad} bad; "
        f"passes {passed.sum()}, {(test.loc[passed, 'fail'] == 0).mean():.1%} right"
    )
    return fitted, cut, p


print(f"test: {len(test)} Sites, {int(test['fail'].sum())} really bad.  Target: fails at least {TARGET:.0%} right.\n")
report("Jev yes/no probability only", ["jev_buy"])
report("8 signals", SIGNALS)
fitted, cut, p = report("8 signals + Jev yes/no", SIGNALS + ["jev_buy"])
report("8 signals + Jev yes/no + traffic", SIGNALS + ["jev_buy", "log_traffic", "log_keywords"])

print("\n8 signals + Jev yes/no, the whole trade-off on test:")
print("  cut   fails   right-when-fail   bad caught   right-when-pass")
bad = int(test["fail"].sum())
for c in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
    failed = p >= c
    right = int(test.loc[failed, "fail"].sum())
    print(
        f"  {c:.2f}  {failed.sum():5d}   {right / max(1, failed.sum()):14.0%}   {right:5d}/{bad}"
        f"   {(test.loc[~failed, 'fail'] == 0).mean():14.1%}"
    )

weights = fitted.steps[-1][1].coef_[0]
print("\nwhat counts toward fail (standardised weight):")
for name, w in sorted(zip(SIGNALS + ["jev_buy"], weights), key=lambda pair: -abs(pair[1])):
    print(f"  {name:22s} {w:+.2f}")

pd.DataFrame({"domain": test["domain"], "p_fail": p.round(3)}).to_csv(OUT, index=False)
