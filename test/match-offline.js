const WyvernAtomicizer = artifacts.require('WyvernAtomicizer');
const WyvernExchange = artifacts.require('WyvernExchange');
const StaticMarket = artifacts.require('StaticMarket');
const WyvernRegistry = artifacts.require('WyvernRegistry');
const TestERC20 = artifacts.require('TestERC20');
const TestERC1155 = artifacts.require('TestERC1155');

const Web3 = require('web3');
const provider = new Web3.providers.HttpProvider('http://localhost:8545');
const web3 = new Web3(provider);

const { wrap } = require('./utils');

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const CHAIN_ID = 50;

contract('WyvernProtocolMatching', (accounts) => {

    const deployWyvernContracts = async () => {
      let [ registry, atomicizer ] = await Promise.all([ WyvernRegistry.new(), WyvernAtomicizer.new() ])
      let [ exchange, static ] = await Promise.all([ WyvernExchange.new(CHAIN_ID,[registry.address],'0x'), StaticMarket.new() ])
      await registry.grantInitialAuthentication(exchange.address)

      return {
        registry,
        exchange: wrap(exchange),
        atomicizer,
        static
      }
    }

    const deployBatchContracts = async (contracts) => await Promise.all(contracts.map(contract => contract.new()))

    it('Matches One erc1155 with erc20 value', async () => {

      // Alice is selling her Erc1155 token for Bobs Erc20 tokens
      const alice = accounts[0];
      const bob = accounts[1];


      const tokenId = 5;
      const price = 3000;
      const sellingAmount = 1;
      const sellingPrice = price;
      const buyingPrice = price;
      const buyingAmount = 1;
      const erc1155MintAmount = 1;
      const erc20MintAmount = price;

      let { exchange, registry, static } = await deployWyvernContracts()
      let [ erc20, erc1155 ] = await deployBatchContracts([ TestERC20, TestERC1155 ])

      await registry.registerProxy({ from: alice })
      let firstProxy = await registry.proxies(alice)
      assert.equal(true, firstProxy.length > 0, 'there is no proxy address for alice')
  
      await registry.registerProxy({from: bob})
      let secondProxy = await registry.proxies(bob)
      assert.equal(true, secondProxy.length > 0, 'there is no proxy address for bob')
  
      await Promise.all([ erc1155.setApprovalForAll(firstProxy, true, { from: alice }), erc20.approve(secondProxy, erc20MintAmount, { from: bob })])
      await Promise.all([ erc1155.mint(alice, tokenId, erc1155MintAmount), erc20.mint(bob, erc20MintAmount)])

      const erc1155Contract = new web3.eth.Contract(erc1155.abi, erc1155.address)
      const erc20Contract = new web3.eth.Contract(erc20.abi, erc20.address)
      const firstSelector = web3.eth.abi.encodeFunctionSignature('anyERC1155ForERC20(bytes,address[7],uint8[2],uint256[6],bytes,bytes)')
      const secondSelector = web3.eth.abi.encodeFunctionSignature('anyERC20ForERC1155(bytes,address[7],uint8[2],uint256[6],bytes,bytes)')
  
      const aliceParams = web3.eth.abi.encodeParameters(
        ['address[2]', 'uint256[3]'],
        [[erc1155.address, erc20.address], [tokenId, 1, sellingPrice]]
      )
      const bobParams = web3.eth.abi.encodeParameters(
        ['address[2]', 'uint256[3]'],
        [[erc20.address, erc1155.address], [tokenId, buyingPrice, 1]]
      )
  
      const aliceOrder = {
        registry: registry.address,
        maker: alice,
        staticTarget: static.address,
        staticSelector: firstSelector,
        staticExtradata: aliceParams,
        maximumFill: 1 * sellingAmount,
        listingTime: '0',
        expirationTime: '10000000000',
        salt: '5'
      }
      const bobOrder = {
        registry: registry.address,
        maker: bob,
        staticTarget: static.address,
        staticSelector: secondSelector,
        staticExtradata: bobParams,
        maximumFill: buyingPrice*buyingAmount,
        listingTime: '0',
        expirationTime: '10000000000',
        salt: '6'
      }

      const firstTransaction = erc1155Contract.methods.safeTransferFrom(alice, bob, tokenId, buyingAmount, "0x").encodeABI() + ZERO_BYTES32.substr(2)
      const secondTransaction = erc20Contract.methods.transferFrom(bob, alice, buyingAmount * buyingPrice).encodeABI()

      const firstCall = {
        target: erc1155.address,
        howToCall: 0,
        data: firstTransaction
      }
      const secondCall = {
        target: erc20.address,
        howToCall: 0,
        data: secondTransaction
      }
  
      let aliceSignature = await exchange.sign(aliceOrder, alice)
      let bobSignature = await exchange.sign(bobOrder, bob)

      await exchange.atomicMatchWith(aliceOrder, aliceSignature, firstCall, bobOrder, bobSignature, secondCall, ZERO_BYTES32, { from: alice })

      let [ alice_erc20_balance, bob_erc1155_balance ] = await Promise.all([ erc20.balanceOf(alice), erc1155.balanceOf(bob, tokenId) ])

      assert.equal(alice_erc20_balance.toNumber(), sellingPrice * buyingAmount, 'ERC20 balance is wrong')
      assert.equal(bob_erc1155_balance.toNumber(), buyingAmount, 'ERC1155 balance is wrong')
    });
});