// Last Call ($LAST): NEAR smart contract. Spec: docs/plans/contract-spec.md.

use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct Contract {}

#[near]
impl Contract {}
