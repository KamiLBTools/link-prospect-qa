"""
A trained buy / don't-buy model on the numbers alone, as a baseline for the judge.

Reads eval/compare/sites.csv (written by `npm run compare`), trains on the
train split only, and writes a prediction for every Site to
eval/compare/ml-predictions.csv, which `npm run compare -- --score` reads.

Two candidates — logistic regression and gradient boosting — are compared by
5-fold cross-validation on the train split; the better one is refitted on the
whole train split. The test split is never looked at until the final predict.

Needs scikit-learn and pandas:  pip install scikit-learn pandas
"""

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import FunctionTransformer, OneHotEncoder, StandardScaler

SITES = "eval/compare/sites.csv"
OUT = "eval/compare/ml-predictions.csv"

NUMERIC = [
    "dr", "traffic", "keywords", "refdomains", "linked_domains", "out_in_ratio",
    "page_count", "coverage", "branded_share", "nav_share", "remainder_pages",
    "ranks_for_almost_nothing", "profile_confidence", "solicits_contributors",
]
# Heavy-tailed counts: the model sees their logs.
LOGGED = ["traffic", "keywords", "refdomains", "linked_domains", "out_in_ratio"]
CATEGORICAL = ["site_type", "topic_breadth", "language", "country", "taxonomy_top"]

sites = pd.read_csv(SITES, keep_default_na=False, na_values=[""])
sites["buy"] = sites["human"].isin(["meh", "good", "excellent"]).astype(int)
for column in LOGGED:
    sites[column] = np.log1p(sites[column].clip(lower=0))
for column in CATEGORICAL:
    sites[column] = sites[column].fillna("unknown").astype(str)

# "extra" is the reviewer's list of rejected sites: training only, never tested on.
train = sites[sites["split"] != "test"]
test = sites[sites["split"] == "test"]
X_train, y_train = train[NUMERIC + CATEGORICAL], train["buy"]

# The extra sites are all rejections, so they skew the training mix far from
# what the model will meet. Weight the classes back to the reviewer's real buy
# rate (from the labelled PEPO rows): the model learns from every rejected
# site's variety without learning that rejection is the norm.
real_rate = sites.loc[sites["split"] == "train", "buy"].mean()
positives, negatives = y_train.sum(), len(y_train) - y_train.sum()
weight = np.where(y_train == 1, 1.0, positives * (1 - real_rate) / real_rate / negatives)


def features(scale: bool) -> ColumnTransformer:
    numeric = [SimpleImputer(strategy="median", add_indicator=True)]
    if scale:
        numeric.append(StandardScaler())
    return ColumnTransformer([
        ("num", make_pipeline(*numeric), NUMERIC),
        ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=5, sparse_output=False), CATEGORICAL),
    ])


candidates = {
    "logistic regression": make_pipeline(features(scale=True), LogisticRegression(max_iter=2000, C=0.5)),
    "gradient boosting": make_pipeline(
        features(scale=False),
        HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=200, random_state=0),
    ),
}

folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
print(f"train {len(train)}  test {len(test)}  (train buy rate {y_train.mean():.1%}, weighted to {real_rate:.1%})")
print("5-fold CV buy-decision accuracy on train:")
cv = {}
for name, model in candidates.items():
    step = model.steps[-1][0]
    scores = cross_val_score(
        model, X_train, y_train, cv=folds, scoring="accuracy", params={f"{step}__sample_weight": weight},
    )
    cv[name] = scores.mean()
    print(f"  {name:20s} {scores.mean():.1%} ± {scores.std():.1%}")

best = max(cv, key=cv.get)
model = candidates[best]
model.fit(X_train, y_train, **{f"{model.steps[-1][0]}__sample_weight": weight})
print(f"chosen: {best}")

probability = model.predict_proba(sites[NUMERIC + CATEGORICAL])[:, 1]
pd.DataFrame({
    "domain": sites["domain"],
    "split": sites["split"],
    "buy": (probability >= 0.5).astype(int),
    "p_buy": probability.round(3),
}).to_csv(OUT, index=False)
print(f"predictions written to {OUT}")

importance = permutation_importance(
    model, test[NUMERIC + CATEGORICAL], test["buy"], n_repeats=20, random_state=0, scoring="accuracy",
)
ranked = sorted(zip(NUMERIC + CATEGORICAL, importance.importances_mean), key=lambda pair: -pair[1])
print("what it leans on (test-split permutation importance):")
for name, value in ranked[:6]:
    print(f"  {name:26s} {value:+.3f}")
