/**
 * Full legal text for the site's three governing documents — Terms of
 * Service, Terms of Use and Privacy Policy — sourced verbatim from counsel's
 * combined ToS/ToU/Privacy Policy document (9 September 2026), minus the
 * vendor sign-off block at the end (that belongs to an actual onboarding
 * sign-off flow, not a public page).
 *
 * A string block is a paragraph; a string[] block renders as a bullet list.
 * "**bold**" inside any string renders as <strong> (see renderInline in
 * TermsPage.tsx). This file is a verbatim mirror of
 * frontends/parent/src/data/legalDocs.ts — keep the two in sync.
 */

export type LegalBlock = string | string[];

export interface LegalSection {
  number: string;
  title: string;
  blocks: LegalBlock[];
}

export interface LegalDoc {
  key: "tos" | "tou" | "privacy";
  label: string;
  shortLabel: string;
  updated: string;
  intro: LegalBlock[];
  sections: LegalSection[];
}

const TOS: LegalDoc = {
  key: "tos",
  label: "Terms of Service",
  shortLabel: "ToS",
  updated: "9 September 2026",
  intro: [],
  sections: [
    {
      number: "1",
      title: "General Terms",
      blocks: [
        'We are BabyBrain Pte. Ltd. (UEN 202627181H) trading as https://www.babybrain.sg/ ("BabyBrain").',
        'In these terms of service ("Terms"), the words "we", "our" and "us" refer to BabyBrain and "Platform" means collectively BabyBrain\'s websites, webpages and/or applications which we may manage, own or operate from time to time, each of which shall be described as a "Platform", including all content, information, applications, programmes, images/graphics, links, sounds, videos and materials which may be displayed on such Platforms, and the functions or services provided therein.',
        'By accessing and using our Platform and/or our services accessible from and on such Platform ("Services") as either a business ("Vendor", "your" or "you") using our Platform to list and place activities, or a customer of a Vendor ("Client", "your" or "you") browsing or making a booking (each, a "Booking") with respect to activities, classes or events listed on our Platform by Vendors (the "Vendor Services"), or otherwise transacting through any booking page, widget or checkout flow powered by BabyBrain, you confirm that you are in agreement with and legally bound by these Terms, our Terms of Use and Privacy Policy as modified from time to time. Please continue accessing our Platform only if these Terms are acceptable to you. These terms apply to our Platforms and any email or other type of communication between you and BabyBrain, as well as our Services and any payment you make to us using a bank account, credit card or debit card ("Payment Method") for Subscription to our Services and one-time purchases.',
        'BabyBrain is a platform which facilitates bookings and communications between Vendors and Clients in respect of Vendor Activities and provides scheduling, messaging and calendar integration tools, customer and waitlist management, point-of-sale functions, attendance and performance tracking and analytics and additional operational features. For the avoidance of doubt, BabyBrain does not provide, offer, oversee, manage, licence or supervise any Vendor Activities. Instead, we offer digital tools that help Vendors and Customers manage their operations and bookings in respect of such Vendor Services, as the case may be. Vendors hereby represent, warrant and undertake that you shall only use our Services exclusively for purposes relating to your trade, business, craft or profession.',
        "You must be at least 18 years old to use our Platform and Services. By accessing and using the same, you hereby represent and warrant that you are at least 18 years old.",
        "Capitalised terms used in these Terms shall have the following meanings:",
        [
          '**"Client Account":** An account registered by a Client on our Platform.',
          '**"Content":** Any data or content uploaded to and/or displayed on our Platform, including all features and functionality (including but not limited to all information, software, text, displays, images, video, audio, staff profiles, images, service lists, pricing, and customer details).',
          '**"Payment Processor":** Third-party payment providers appointed by BabyBrain from time to time, including but not limited to Stripe.',
          '**"Total Payment":** The amount agreed to be payable by a Client to a Vendor in respect of a Booking.',
          '**"Users":** Individuals authorised by a Business Account owner to access our Platform (e.g., staff members, managers, administrators).',
          '**"Vendor Account":** An account registered by a Vendor on our Platform.',
        ],
      ],
    },
    {
      number: "2",
      title: "About BabyBrain",
      blocks: [
        "BabyBrain is not a party to any Booking, service agreement or transaction between a Client and a Vendor. Vendors are independent service providers and are not employees, agents, joint ventures or contractors of BabyBrain. Vendors fully control their services, pricing, booking policies, customer relationships and compliance with applicable laws and regulations.",
      ],
    },
    {
      number: "3",
      title: "Account Creation and Security",
      blocks: [
        "To use our Services, you must create either a Vendor Account or a Client Account (as applicable) and provide accurate information as requested on and prompted by our Platform, including but not limited to:",
        [
          "Your name and business registration number (as applicable)",
          "Contact information",
          "Staff information (as applicable)",
          "Payment details (for subscription payments and Bookings)",
        ],
        "You agree to:",
        [
          "Keep your login credentials secure",
          "Ensure all information is accurate and up to date",
          "Ensure Users who have access to your Vendor Account are your authorised representatives",
          "Accept full responsibility for all actions and activities taken by you or any third party through your Vendor Account or Client Account (as applicable)",
          "Notify BabyBrain immediately upon learning of any unauthorised use of your Vendor Account or Client Account (as applicable) or any other breach of security",
        ],
        "BabyBrain reserves the right to refuse, suspend, or terminate any Vendor Account or Client Account that violates these Terms.",
      ],
    },
    {
      number: "4",
      title: "Business Operations",
      blocks: [
        "BabyBrain does not:",
        [
          "Guarantee availability of any Vendor Activities",
          "Confirm appointment accuracy with respect to any Booking",
          "Mediate disputes between Vendors and Clients",
          "Set service policies, prices, or cancellation terms in respect of Vendor Activities",
        ],
        "Vendors alone are responsible for:",
        [
          "Setting policies (including in respect of deposit, cancellation, no-show, refund and privacy policies)",
          "Managing communications and disputes between Vendors and Clients",
          "Handling refunds, disputes, and service outcomes between Vendors and Clients",
        ],
      ],
    },
    {
      number: "5",
      title: "Bookings",
      blocks: [
        "Clients make Bookings and transact directly with Vendors. BabyBrain acts only as an intermediary to help list Vendor Activities, refer Clients to Vendors and increase Vendor traffic. Any contract, arrangement or agreement is between a Client and a Vendor. BabyBrain is not a party to, nor liable under, any contract, arrangement or agreement entered into between a Client and a Vendor, nor is it a contracting agent, affiliate or insurer. Each Vendor is solely responsible for the quality and integrity of the Vendor Services provided, as well as the accuracy of its listings, prices, availability and policies (including in respect of cancellation, no-show, refund and privacy policies) stated on our Platform.",
        "To the furthest extent possible or permitted by BabyBrain, Vendors and Clients should ensure communications between Vendors and Clients concerning Bookings (potential, pending or otherwise) take place via BabyBrain's internal messaging tools. Except where facilitated or permitted by BabyBrain, Vendors and Clients are not allowed to exchange personal, contact or other information, or to communicate with each other other than via BabyBrain's internal messaging tools, and are prohibited from using the Platform to facilitate or solicit the entry into contracts or bookings outside of the Platform. If any communication, information, data, or details were exchanged between any Vendor and Client (whether transmitted in written, oral, electronic, graphic or in any other tangible form, including but not limited to text messages, instant messages, emails, phone calls, fax, mail, data transfer, any exchange of documents, online or in-person meetings) and/or any transaction was made between any Vendor and Client in breach of the above, this will constitute a material breach of these Terms allowing BabyBrain to suspend or delete the relevant Vendor Account and Client Account in its sole discretion, and restrict or block access by the relevant Vendor and Client to our Platform and Services.",
        "BabyBrain may contact a Client at any time after our internal messaging tools have been used to facilitate communication between a Client and a Vendor to enquire after or review the status of a Booking.",
        "BabyBrain shall not be responsible for any losses or damages resulting from fraudulent Bookings. Vendors are encouraged to exercise due diligence when accepting Bookings, particularly for high-value transactions. Any suspicious activity should be reported to BabyBrain.",
        'BabyBrain may allow Clients to leave a review and rating of a Vendor and/or Vendor Activities subsequent to a Booking. Such reviews and ratings will not be altered by BabyBrain and will be published on our Platform as submitted. Vendors agree not to: (a) submit, commission or incentivise untrue or inaccurate reviews; (b) offer undisclosed incentives, payments or benefits in exchange for positive reviews; or (c) attempt to manipulate ratings through artificial means, including creating false Client Accounts or coordinated review campaigns. Vendors additionally agree to: (i) report any suspicious review activity to us immediately; (ii) cooperate with our investigations; (iii) provide evidence and documentation as reasonably requested by us; and (iv) accept our final decision regarding any review or rating disputes.',
      ],
    },
    {
      number: "6",
      title: "Commission on Bookings",
      blocks: [
        '**(a) Commission:** In consideration for the use of our Platform, BabyBrain charges a non-refundable commission ("Commission") on each Booking made through our Platform, calculated as a percentage of the Total Payment, which may differ depending on the plan which the Vendor has subscribed to. Each Vendor hereby authorises the Payment Processor to deduct the Commission payable to BabyBrain from the Total Payment and pay out the same to BabyBrain. Where a Vendor decides to give a discount due to failure to provide a Vendor Service, unsatisfactory service or similar circumstances, such discount shall not affect the Total Payment for the purposes of calculating the Commission. Vendors hereby agree not to charge Clients separately for the Commission you owe or would owe us for any Booking made through our Platform. All rights and obligations in respect of payment of any Commission are binding on each Vendor and BabyBrain as well as their respective assignees and successors.',
        "**(b) Payment processing for Bookings:** Stripe is the current Payment Processor for credit and debit card payments. Whenever a payment is processed by Stripe, the terms and conditions of the Stripe Services Agreement and Stripe Connected Account Agreement, as well as other applicable Stripe terms and policies, shall apply as may be amended by Stripe from time to time. Each Vendor is responsible for reviewing, accepting and complying with all such terms and conditions. A Vendor's use of such payment processing is subject to its compliance with all the applicable terms and conditions of Stripe, and each Vendor using such payment processing will be required to set up a Stripe Connect Account and complete a required verification process. For the avoidance of doubt, the Payment Processor (not BabyBrain) collects, processes, authorises, settles and pays out the funds to the Vendor and Commission to BabyBrain, and deducts its own processing fees. The Vendor remains the merchant of record for all Bookings made via our Platform. BabyBrain will not be responsible for the acts or omissions of the Payment Processor or how personal information is treated by the Payment Processor.",
        "**(c) Chargebacks and disputes:** BabyBrain is not responsible for, and you release BabyBrain from liability arising out of, any chargebacks, disputes, refunds and the funds required to cover them, failed, declined, duplicated or reversed transactions, processing fees, payout timing, reserves, holds, account reviews or suspensions imposed by the Payment Processor, or the Payment Processor's availability, errors or changes to its services, fees or terms, or a Vendor's eligibility for, or onboarding to, the Payment Processor. Each Vendor remains solely responsible for funding any refunds or chargebacks, any applicable taxes (including goods and services tax) on your sales, and for complying with applicable laws and card-network rules when accepting payments. None of these matters shall affect the Total Payment for the purpose of calculating the Commission, and no refund of the Commission shall be made under any circumstances.",
      ],
    },
    {
      number: "7",
      title: "Subscription Fees",
      blocks: [
        '**(a) Subscription:** BabyBrain may charge both Clients and Vendors subscription fees for premium platform features. If you have purchased a subscription to a paid plan ("Subscription"), whether as a Client or Vendor, you may either pay on a monthly basis and cancel anytime with 14 days\' notice on the monthly plan, or pay on an annual basis with no refund in the event of early cancellation on the annual plan. BabyBrain reserves the right to adjust the Subscription fees at any time and for any reason with 14 days\' notice. To continue to use our Services, you must agree to any such change in fee. If you do not agree to such change, you may cancel your Subscription in accordance with these Terms.',
        "**(b) Automatic renewal:** Unless otherwise stated herein, if you have purchased a Subscription, payment authorisation provided under these Terms will continue for the length of the Service you've selected (e.g. annual or monthly) and will automatically renew pursuant to the contract for the Service on an annual or monthly basis, at the rates in effect at the time, unless terminated in accordance with these Terms.",
        "**(c) Payment methods:** We may elect to accept or decline any Payment Method for any reason, in our sole discretion. If any payment falls on a weekend or public holiday, such payment may be processed on the next business day. If a recurring payment is not authorised, we will send you a notice at the email address provided to us. You will have 14 calendar days from that date to make alternative arrangements to make the payment, failing which we may cancel your access to the Services and/or any Subscription and terminate these Terms.",
        '**(d) Card payments:** Payment for our Services may only be made with a credit or debit card ("Card") that we accept and that has been issued to you as the cardholder, and for which you have provided us with the information we require to process payments. We may obtain updated information regarding your selected Payment Method as made available by your financial institution or through a Card updater service. You hereby authorise BabyBrain (or its agent) to obtain payment of all fees incurred or agreed to be incurred for the Services, either now or any time in the future, via charge(s) to the account accessed using the Card (including any applicable taxes, fees and costs). All Card and payment details are entered only through the Payment Processor\'s secure technology.',
        "**(e) Duration and recurring payments:** The authorisation to charge your Payment Method of choice will remain in effect until you cancel it in accordance with our procedures, which may be amended from time to time, as described in these Terms. You may cancel this authorisation at any time if you notify us at least 14 days prior to the next billing date. If you agree to a recurring payment, you are authorising regularly scheduled charges to your Payment Method of choice. You will be charged the applicable payment for each billing period. A receipt for each payment will be provided to you at the email address you have provided to us, and the charge will appear on the next periodic statement you receive for transactions on your bank statement or Card. You agree that we are not required to provide you with prior notification of recurring payments unless the date or amount of the payment changes other than as previously notified to you, in which case we will send you a notice, addressed to the email address you have provided to us, prior to the date the payment is processed.",
        "**(f) Late or non-payments:** If you do not pay your balance, we may terminate your Subscription or access to the Services and these Terms, and charge a late fee, in our sole discretion. For unpaid amounts, we reserve the right to retry your Payment Method. If you choose to reactivate your Subscription, we may charge a reactivation fee, and will apply payments first to any past due amounts and then to your current and future obligations. BabyBrain may, in our sole discretion, refuse this payment option to anyone or any user without notice for any reason at any time.",
        "**(g) Your undertakings:** You hereby undertake, represent and warrant the following:",
        [
          '**(i)** You will be responsible for payment if the electronic payment fails due to insufficient funds in your Payment Method or any other reason. By choosing a Payment Method, you agree that: (1) you have read, understand and agree to these Terms, and that this agreement constitutes a "writing signed by you" under any applicable law or regulation; and (2) you authorise BabyBrain (or its agent) to make any inquiries we consider necessary to validate any dispute involving your payment, which may include ordering a credit report and performing other credit checks or verifying the information you provide against third party databases.',
          "**(ii)** You are responsible for ensuring that all information provided as part of the Service, including information concerning the Payment Method, is correct, accurate and complete.",
          "**(iii)** Each time you authorise a one-time or recurring payment, or provide information concerning your Payment Method, you are representing, warranting, and confirming that: (1) you are over 18 years of age; (2) you have the appropriate authority to accept and agree to these Terms; (3) you are an authorised user of the Payment Method and the Payment Method is issued in your name; (4) you are authorised to make and authorise payments using the Payment Method; and (5) there are sufficient funds and/or sufficient credit available on the Payment Method at the time each payment is processed to fund the payment in full, and will not dispute any scheduled transactions with your bank and card issuer, so long as the transactions correspond to these Terms.",
          "**(iv)** You will notify us of any changes in the account information for your Payment Method prior to the next billing date, and of any change to your contact information, including your email address.",
          "**(v)** You are responsible for any charges or fees assessed against the Payment Method by the card issuer or any other third party, as applicable.",
          "**(vi)** You are responsible for paying any costs incurred by us for any collection process or legal action to collect any money or fees owed to us, including any reasonable attorneys' fees, which may be charged to your Payment Method.",
        ],
        "**(h) Cancellations and refunds:** With respect to a Monthly plan, you may cancel your Subscription anytime with 14 days' notice. Your cancellation will take effect at the end of your then-current billing period (or, if the 14-day notice period expires after that date, at the end of the following billing period), and you will continue to have access to our Services until that date. Subscription fees already paid are non-refundable, except as required by applicable law. You acknowledge that you are ineligible for any pro-rated refund of any amount of the Subscription fees paid for the then-current billing period during which you request cancellation. With respect to an Annual plan, the Subscription cannot be cancelled or refunded once payment has been made, save in the event of a typographical error as detailed in Section 28. You may only cancel future charges associated with your purchase and terminate your Subscription in accordance with these Terms.",
      ],
    },
    {
      number: "8",
      title: "Refund Policies",
      blocks: [
        "Vendors set their own cancellation, no-show, and refund policies. BabyBrain does not set, mandate, or guarantee any particular refund outcome, and its Commission remains fully payable regardless of whether a Booking is cancelled or amended in any way.",
        "Each Vendor is solely responsible for:",
        [
          "Clearly disclosing its deposit, cancellation, no-show, and refund terms to your customers before they pay, and obtaining their agreement and any required consent to save a card",
          "Deciding whether a deposit is refundable or forfeited, and processing any refunds you choose to give",
          "Complying with all applicable laws, and card-network rules, in how you charge, save cards, and handle refunds",
        ],
        "Any dispute with respect to a Booking is between a Vendor and a Client (and, where relevant, the Payment Processor). You hereby release BabyBrain from all liability arising out of such dispute.",
      ],
    },
    {
      number: "9",
      title: "Intellectual Property",
      blocks: [
        "The Platform and all Services provided (including all software, platform architecture, UI/UX design, logos, trademark and branding and Content created by BabyBrain therein) is, and will remain, the property of BabyBrain. All such rights are reserved by BabyBrain and its licensors, as the case may be. BabyBrain grants you a revocable, non-exclusive, non-sublicensable, non-transferable, limited license to download, install and use our Platform strictly in accordance with these Terms and solely as necessary for you to use our Services.",
        "BabyBrain does not claim ownership of your Content. However, you grant to us a worldwide, irrevocable, non-exclusive, perpetual, royalty-free licence to:",
        [
          "use, reproduce, store, adapt, publish, translate and distribute your Content in any existing or future media;",
          "reproduce, store and publish your Content on and in relation to our Platform and any successor Platform;",
          "manage, edit, adapt, and improve your Content that you created on our Platform; and",
          "use your Content that you provided to us or that you made publicly available for our own marketing, advertising and commercial purposes.",
        ],
        "You grant us the right to sub-licence, and to bring an action for infringement of, the abovementioned rights. You hereby waive all your moral rights in your Content to the maximum extent permitted by applicable laws.",
        "Each Vendor and Client hereby grants us the irrevocable right to use any photos, videos or other forms of media taken of you during the provision of Vendor Services, in whole or in part, in any media now or hereafter known, including but not limited to electronic direct mails (EDMs), marketing collaterals, print advertisements, posters, illustrations, advertising and social media platforms. Each Vendor and Client hereby releases and discharges BabyBrain and all assigned photographers from any and all claims and demands that may arise out of or in connection with the use of such photos, videos or media, including but not limited to any and all claims for libel or violation of right of publicity or privacy.",
      ],
    },
    {
      number: "10",
      title: "Content",
      blocks: [
        "You warrant and represent that your Content will comply with these Terms. Your Content must not be illegal or unlawful, infringe any person's legal rights or any other terms and conditions, or be capable of giving rise to legal action against any person (in each case in any jurisdiction and under any applicable law). Further, your Content and the use of your Content by us in accordance with these Terms, as well as all communication with Clients, must not:",
        [
          "be untrue, false, inaccurate or misleading;",
          "be libellous or maliciously false, obscene or indecent;",
          "infringe any copyright, moral right, database right, trade mark right, design right, right in passing off, or other intellectual property right, or any right of confidence, right of privacy or right under data protection legislation;",
          "constitute negligent advice or contain any negligent statement;",
          "constitute an incitement to commit a crime, instructions for the commission of a crime or the promotion of criminal activity;",
          "be in contempt of any court, or in breach of any court order;",
          "be in breach of racial or religious hatred or any applicable laws and regulations;",
          "be in breach of any contractual or confidentiality obligation owed to any person;",
          "be pornographic, lewd, suggestive or sexually explicit or depict violence;",
          "consist of or contain any instructions, advice or other information which may be acted upon and could, if acted upon, cause illness, injury or death, or any other loss or damage;",
          "constitute spam;",
          "be offensive, defaming, blasphemous, deceptive, fraudulent, threatening, abusive, harassing, anti-social, menacing, hateful, embarrassing, discriminatory or inflammatory;",
          "cause annoyance, inconvenience or needless anxiety to any person; or",
          "be provided with an intention to impersonate any other person, misrepresent your identity or your affiliation with any person, or to give a false impression that your Content comes from another person.",
        ],
        "BabyBrain has no obligation to oversee, check, review, modify or remove any Content that breaches these Terms. However, if BabyBrain finds content in breach of these Terms or applicable law, we may modify or remove such Content in our sole discretion.",
      ],
    },
    {
      number: "11",
      title: "Privacy",
      blocks: [
        "Each Vendor is solely responsible for complying with applicable privacy laws in respect of its management, use, handling and collection of Client Data. Please read our Privacy Policy.",
      ],
    },
    {
      number: "12",
      title: "Features",
      blocks: [
        'BabyBrain may from time to time provide enhancements or improvements to the features/functionality of our Platform and Services, which may include patches, bug fixes, updates, upgrades and other modifications ("Updates"). Updates may modify or delete certain features and/or functionalities of our Platform and Services. You agree that BabyBrain has no obligation to: (a) provide any Updates; or (b) continue to provide or enable any particular features and/or functionalities of our Platform and/or Services to you. You further agree that all Updates will be: (i) deemed to constitute an integral part of our Platform and Services; and (ii) subject to these Terms.',
        "We reserve the right to change prices, scope and/or contents of our Services and our resources usage policy at any time without prior notice, save that we shall notify you prior to any substantial increase in price. Subject to applicable laws, if you disagree with any proposed price increase, your sole remedy shall be to cancel your Subscription in accordance with the terms herein, and your continued use of the Services without such termination constitutes your agreement to the increased price.",
      ],
    },
    {
      number: "13",
      title: "Information Rights",
      blocks: [
        'BabyBrain will not share any data that may be collected, processed or stored using the Services with respect to the characteristics and activities of Clients ("Client Data") with any third parties unless it: (a) has your consent for any Client Data to be shared in accordance with any relevant privacy policy; (b) concludes that it is required by applicable law or has a good faith belief that access, preservation or disclosure of Client Data is reasonably necessary to protect the rights, property or safety of BabyBrain, its users or the public; or (c) provides Client Data in certain limited circumstances to third parties to carry out tasks on BabyBrain\'s behalf (e.g., billing or data storage) with strict restrictions that prevent the data from being used or shared except as directed by BabyBrain. When this is done, it is subject to agreements that oblige those parties to process Client Data only on BabyBrain\'s express instructions and in compliance with these Terms and appropriate confidentiality and security measures.',
      ],
    },
    {
      number: "14",
      title: "Restrictions",
      blocks: [
        "You agree not to, and you will procure that others do not:",
        [
          "Breach or attempt to breach any applicable laws and regulations.",
          "Reproduce, republish, upload, post, copy, imitate, store, archive, license, sell, rent, lease, assign, distribute, transmit, host, outsource, disclose or otherwise commercially exploit our Platform and Services, or make our Platform and Services available to any third party, save as permitted herein.",
          "Modify, make derivative works of, disassemble, decrypt, reverse compile or reverse engineer any part of our Platform and Services, or otherwise attempt to discover the source code of any software on our Platform. Downloading any software, files, images or data accompanying such software from our Platform and Services does not in any way transfer title of such software to you.",
          "Remove, alter or obscure any proprietary notice (including any notice of copyright or trademark) of BabyBrain or its affiliates, partners, suppliers or the licensors of our Platform and Services.",
          "Use, post, transmit or introduce any device, software or routine which interferes or attempts to interfere with the operation of our Platform and Services.",
          "Do any act that will or may interfere with our Platform's and our Services' accessibility and/or proper functioning, or that will or may place an unreasonable or disproportionately large load on BabyBrain's or its licensors' servers, or use automated tools (including bots and scrapers) without our consent.",
        ],
        "You hereby represent, warrant and undertake that you shall comply with all applicable laws and regulations in your use of and access to the Platform and Services and/or provision of Vendor Services.",
        "If you print, copy or download any part of our Platform in breach of these Terms, your right to use our Platform and Services will cease immediately, and you must, at our option, return or destroy any copies of the materials you have made.",
      ],
    },
    {
      number: "15",
      title: "Access to our Platform and Services",
      blocks: [
        "BabyBrain reserves the right to modify, suspend or discontinue, temporarily or permanently, the Platform or any Services to which it connects, with or without notice. Subject to the provisions herein relating to payment of Subscription fees, you may stop using the Services at any time and you do not need to specifically inform us when you stop using the Services. You acknowledge and agree that if we disable access to your account, you may be prevented from accessing the Services, your account details, or any files, data or other materials contained in your account.",
        "BabyBrain will not be responsible for any outcome that may occur during the course of usage of our resources. The accessibility and operation of our Platform relies on platforms and technologies outside of our control. We are not able to guarantee continuous accessibility or uninterrupted operation of our Platform.",
      ],
    },
    {
      number: "16",
      title: "Term and Termination",
      blocks: [
        "These Terms shall remain in effect until terminated by you or us.",
        "BabyBrain may, in its sole discretion, at any time and for any or no reason, suspend or terminate these Terms and the provision of our Services with or without prior notice, and issue a refund for any Subscription or purchase made in its sole discretion. BabyBrain may also terminate these Terms and the provision of our Services at any time without prior notice where you fail to comply with any Term herein.",
        "With respect to any Subscription, you may, in your sole discretion, suspend or terminate these Terms and the provision of our Services in accordance with paragraph 7(h) above.",
        "Upon termination of these Terms and the provision of our Services, you shall cease all use of our Platform and Services and delete all copies of our Platform from your computer. In the event of any termination of these Terms, your historical analytics and data will no longer be available to you. Termination of these Terms will not limit any of BabyBrain's rights or remedies at law or in equity in case of breach by you of any of your obligations under these Terms.",
      ],
    },
    {
      number: "17",
      title: "No Warranties",
      blocks: [
        'Our Platform and Services are provided to you "AS IS" and "AS AVAILABLE" and with all faults and defects without warranty of any kind. To the maximum extent permitted under applicable law, BabyBrain, on its own behalf and on behalf of our affiliates and our and their respective licensors and service providers, expressly disclaims all warranties, whether express, implied, statutory or otherwise, with respect to our Platform, Services and/or Vendor Services, including all implied warranties of merchantability, fitness for a particular purpose, title and non-infringement, accuracy or availability, and warranties that may arise out of course of dealing, course of performance, usage or trade practice.',
        "Without limitation to the foregoing, BabyBrain provides no warranty or undertaking, and makes no representation or guarantee of any kind, that our Platform and Services and/or Vendor Services will meet your requirements, achieve any intended results, be compatible or work with any other software, systems, browsers or services, operate without interruption, meet any performance or reliability standards, or be error free, or that any errors or defects can or will be corrected.",
        "Without limiting the foregoing, neither BabyBrain nor any of our providers makes any representation or warranty of any kind, express or implied: (a) as to the operation or availability of our Platform and Services and/or Vendor Services, or the information, content, and materials or products included thereon; (b) that the Platform and Services and/or Vendor Services will be uninterrupted or error-free; (c) as to the accuracy, reliability, or currency of any information or content provided through our Platform and Services and/or Vendor Services; (d) that our Platform, its servers, the content, or e-mails sent from or on behalf of BabyBrain are free of viruses, scripts, trojan horses, worms, malware, timebombs or other harmful components; or (e) as to the quality, safety, legality, fulfilment or outcome of any Vendor Services, whether in public, private, or offline interactions, or about the accreditation, registration or licence of any professional involved in providing any Vendor Services.",
      ],
    },
    {
      number: "18",
      title: "Limitation of Liability",
      blocks: [
        "TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, UNDER NO CIRCUMSTANCES (INCLUDING BUT NOT LIMITED TO NEGLIGENCE) SHALL BABYBRAIN OR ITS SUPPLIERS BE LIABLE FOR ANY DAMAGE OR LOSS WHICH YOU SUSTAIN AS A RESULT OF ANY BOOKING MADE THROUGH OUR PLATFORM, INCLUDING WITHOUT LIMITATION ANY SPECIAL, INCIDENTAL, INDIRECT, OR CONSEQUENTIAL DAMAGES WHATSOEVER (INCLUDING, BUT NOT LIMITED TO, DAMAGES FOR LOSS OF PROFITS, INCOME, REVENUE, CONTRACTS OR COMMERCIAL OPPORTUNITIES, FOR LOSS OF DATA OR OTHER INFORMATION, FOR BUSINESS INTERRUPTION, FOR PERSONAL OR BODILY INJURY, DEATH OR EMOTIONAL DISTRESS, FOR DAMAGE TO PROPERTY, FOR LOSS OF PRIVACY ARISING OUT OF OR IN ANY WAY RELATED TO THE USE OF OR INABILITY TO USE OUR PLATFORM, SERVICES, VENDOR SERVICES, THIRD-PARTY SOFTWARE AND/OR THIRD-PARTY HARDWARE USED WITH OUR PLATFORM AND SERVICES, OR OTHERWISE IN CONNECTION WITH ANY OF THESE TERMS), EVEN IF REASONABLY FORESEEABLE OR IF BABYBRAIN HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES OR LOSSES.",
        "Vendors are fully responsible for the quality, safety, legality or fulfilment of any Vendor Services, or any relationship with a Client after a Booking has been made, including but not limited to any amendments, cancellations, claims, refunds, compensation or reimbursement in respect thereof. All claims a Client may have in respect of any Booking or Vendor Service, whether in whole or in part, shall be made against the relevant Vendor.",
        "BabyBrain accepts no responsibility or liability (including, but not limited to, any direct or consequential loss or damage that might occur to you or any other third party) arising out of, or in connection with, sharing personal or sensitive information through our internal messaging tools or communicating or transacting with Clients outside of our Platform. Further, BabyBrain has no control over any conduct of any Vendor or Client and disclaims all liability in this regard to the maximum extent permitted by applicable law. You hereby agree not to make BabyBrain liable for the conduct of Users and/or Vendors (as the case may be), and the risk of damages arising from such conduct rests entirely on you.",
        "BabyBrain cannot and does not guarantee, and is not responsible for, the truthfulness or accuracy of the identities of Vendors or Clients or the Content submitted or provided to our Platform, including any medical or personal information. While BabyBrain may implement certain verification processes in its sole discretion, it shall not be held liable for any losses arising from Vendors or Clients misrepresenting their identity, authority to make Bookings, or the Content provided. Vendors may implement their own additional verification processes when deemed appropriate. BabyBrain does not check, monitor or control the creditworthiness of Clients.",
        "Further, each Client remains responsible for declaring to the Vendor if it or any participant in any Vendor Services has any medical history or underlying physical conditions or medical disabilities, and for informing the relevant Vendor of any discomfort or pain at any time during the performance of the Vendor Services. Where appropriate, each Client should obtain medical clearance or requisite medical advice for his/her or any participant's participation in the Vendor Services, and hereby waives and releases any and all rights and claims for any consequential, incidental or direct injury and damages he/she or any participant may suffer, including without limitation any personal injury or loss of profit, and indemnifies and holds BabyBrain, its directors, management, employees, agents and affiliates harmless from any claims, damages or losses due to or arising from: (i) his/her or any other participant's participation in the Services; or (ii) any breach of these Terms by the Client, including but not limited to legal fees.",
        "In no event shall our total liability to you exceed the total Subscription fees paid by you to us in the past 12 months.",
      ],
    },
    {
      number: "19",
      title: "Indemnification",
      blocks: [
        "To the furthest extent permitted by applicable law, each Vendor and Client hereby agrees to indemnify and hold BabyBrain, its directors, management, employees, agents and affiliates harmless from any third party claims, liability, damages and/or costs, including but not limited to legal fees, due to or arising out of: (a) Content you submit, post, transmit or make available through our Platform; (b) your use of or connection to our Platform and Services and/or Vendor Services; (c) your breach of these Terms; (d) your violation of any rights of or obligations to another or any applicable laws; (e) your use of any analytics or data provided to you pursuant to our Services; (f) any claims made by or on behalf of any third party to which you provide access to your account or for which you use the Service to collect information on such party's behalf (\"Third Party\") pertaining directly or indirectly to your use of our Platform and Services; (g) any claims with respect to acts or omissions of any Third Party in connection with our Platform and Services and/or Vendor Services; (h) any payment handling, cancellation or refund policies, chargebacks or payment disputes; (i) any interaction or communication between Vendors and Clients; or (j) your handling, use or management of Client Data. BabyBrain will provide you with written notice of any relevant claim, suit or action. You will cooperate as fully as reasonably required in the defense of any claim.",
      ],
    },
    {
      number: "20",
      title: "Illegality",
      blocks: [
        "The illegality, invalidity or unenforceability of any Term hereunder under the law of any jurisdiction shall not affect its legality, validity or enforceability under the law of any other jurisdiction, nor the legality, validity or enforceability of any other Term hereunder.",
      ],
    },
    {
      number: "21",
      title: "Waiver",
      blocks: [
        "No failure on the part of either of us to exercise, and no delay on its part in exercising, any right or remedy under these Terms will operate as a waiver thereof, nor will any single or partial exercise of any right or remedy preclude any other or further exercise thereof or the exercise of any other right or remedy. The rights provided in these Terms are cumulative and not exclusive of any rights or remedies provided by law. Either of us may release or compromise the liability hereunder of the other party, or grant to such party time or other indulgence, without affecting the liability of such party hereunder.",
      ],
    },
    {
      number: "22",
      title: "Entire Agreement",
      blocks: [
        "These Terms and the documents referred to in it (including the Terms of Use and the Privacy Policy) constitute the entire agreement between you and BabyBrain regarding your use of our Platform and our Services, and supersede all prior and contemporaneous written or oral agreements, offers and negotiations between you and BabyBrain. You have not agreed to these Terms in reliance upon any representation, warranty or undertaking of the other party which is not set out or referred to in these Terms, save that you may be subject to additional terms and conditions that apply when you use or purchase certain/additional Services, which BabyBrain will provide to you at the time of such use or purchase.",
      ],
    },
    {
      number: "23",
      title: "Updates to Our Terms",
      blocks: [
        "These Terms may be edited, modified or deleted from time to time at our sole discretion, without notifying you. Where a revision is considered in our sole discretion to be material, we may provide at least 30 days' notice prior to such revision taking effect. Updated versions of the Terms will be posted on our Platform and are effective immediately. Your continued use of and access to our Platform and Services after any modifications to the Terms indicates your acceptance of the same, as modified.",
      ],
    },
    {
      number: "24",
      title: "Confidentiality",
      blocks: [
        'All information or materials provided to or disclosed to the other party (or by a third party on their behalf) by BabyBrain, and all information that either of us and those working for us or on our behalf had access to, been entrusted with and/or become acquainted with in connection with the production and delivery of the Services under these Terms, which are not the subject of general public knowledge, shall be deemed to be confidential information ("Confidential Information"). Each of us shall only use the other party\'s Confidential Information for the purposes of the provision and acceptance of Services under these Terms, and for no other purpose. Each of us shall take steps to prevent, protect and avoid unauthorised disclosure, use and reproduction of the other party\'s Confidential Information. Each of us shall not, during or after the term of the provision of Services, disclose or use any such Confidential Information of the other party without first obtaining the other party\'s written authorisation. Each of us shall, at the other party\'s request, require those engaged by either of us to sign confidentiality agreements, in which such persons agree not to use or disclose the other party\'s Confidential Information.',
        'With respect to any Service features which are identified as "Alpha" or "Beta" or as otherwise preliminary, experimental or confidential ("Beta Features"), you may not disclose any information relating to such Beta Features or the terms or existence of any such Beta Features. You hereby agree that BabyBrain has no liability arising out of or relating to any Beta Features. Any use of and access to Beta Features shall be at your own risk and may be subject to additional requirements as specified by BabyBrain. BabyBrain is not obliged to provide support for Beta Features, and it may, in its sole discretion, cease providing Beta Features at any time, for any reason.',
        "These Terms impose no obligations with respect to information which: (a) was in either party's possession before receipt from the disclosing party; (b) is or becomes a matter of public knowledge through no fault of the receiving party; (c) was rightfully disclosed to the receiving party by a third party without restriction on disclosure; or (d) is developed by the receiving party without use of the Confidential Information, as can be shown by documentary evidence. The receiving party may make disclosures to the extent required by applicable law, government authorities or court order, provided the receiving party makes commercially reasonable efforts to provide the disclosing party with notice of such disclosure as promptly as possible and uses diligent efforts to limit such disclosure and obtain confidential treatment or a protective order, and has allowed the disclosing party to participate in the proceeding.",
      ],
    },
    {
      number: "25",
      title: "Rights of Third Parties",
      blocks: [
        "Any person who is not a party to these Terms shall have no right under the Contracts (Rights of Third Parties) Act 2001 of Singapore to enforce any Term.",
      ],
    },
    {
      number: "26",
      title: "Governing Law",
      blocks: [
        "The access and use of our Platform and Services and its Content, and these Terms, shall be governed by and construed in accordance with the laws of the Republic of Singapore.",
        "In the event a dispute or difference arises between you and us as to any matter of whatsoever nature arising under these Terms or in connection therewith, you or we must give the other party a Notice of Dispute, which is a written statement that sets forth the name, address, and contact information of the party giving it, the facts giving rise to the dispute, and the relief requested. You must send any Notice of Dispute via email to: hello@babybrain.sg. We will send any Notice of Dispute to you by mail to your email address. You and BabyBrain will use reasonable endeavours in good faith to resolve any dispute through informal negotiation within sixty (60) days from the date such Notice of Dispute is sent. Neither party may commence legal proceedings in respect of the Dispute until the expiry of such 60-day period, except where permitted by applicable law.",
        "Subject to the dispute resolution procedure above, the parties hereto agree to submit to the non-exclusive jurisdiction of the courts of Singapore.",
      ],
    },
    {
      number: "27",
      title: "Feedback",
      blocks: [
        "In the event that you submit, share or post any feedback, comments, ideas, creative suggestions, designs, photographs, information, advertisements, data or proposals, including ideas for new or improved products, services, features, technologies or promotions, you expressly agree that such submissions will automatically be treated as non-confidential and non-proprietary and will become the sole and exclusive property of BabyBrain without any compensation or credit to you whatsoever. BabyBrain and its affiliates shall have no obligations with respect to such feedback, submissions or posts, and may copy, modify, publish, redistribute or otherwise use the ideas contained in such submissions or posts for any purpose in any medium in perpetuity, including but not limited to developing, manufacturing, and marketing products and services using such ideas, without any credit or compensation to you.",
      ],
    },
    {
      number: "28",
      title: "Typographical Errors",
      blocks: [
        "In the event a Service is listed at an incorrect price or with incorrect information due to a typographical error, we shall have the right, in our sole discretion, to refuse or cancel any orders placed for the Service listed at the incorrect price or with incorrect information. We shall have the right to refuse or cancel any such order whether or not the order has been confirmed and your Payment Method charged. If your Payment Method has already been charged for the purchase and your order is cancelled, we shall immediately issue a credit to your Payment Method.",
      ],
    },
    {
      number: "29",
      title: "Miscellaneous",
      blocks: [
        "BabyBrain operates our Platform and Services from our offices in Singapore. Our Platform and Services are not intended for distribution to or use by any person or entity in any jurisdiction or country where such distribution or use would be contrary to applicable law or regulation. Accordingly, persons who choose to access our Platform and Services from other locations do so on their own initiative and are solely responsible for compliance with local laws, if and to the extent local laws are applicable.",
        "BabyBrain shall perform the Services as an independent contractor, and nothing in these Terms shall be deemed to create any association, partnership, joint venture, or relationship of principal and agent or master and servant between BabyBrain and any Client or Vendor or any of our affiliates or subsidiaries, or to provide either BabyBrain or any Client or Vendor with the right, power or authority, whether express or implied, to create any such duty or obligation on behalf of the other party.",
      ],
    },
    {
      number: "30",
      title: "Contact Us",
      blocks: ["Don't hesitate to contact us if you have any questions. Email: hello@babybrain.sg."],
    },
  ],
};

const TOU: LegalDoc = {
  key: "tou",
  label: "Terms of Use",
  shortLabel: "ToU",
  updated: "9 September 2026",
  intro: [],
  sections: [
    {
      number: "1",
      title: "General Terms",
      blocks: [
        'We are BabyBrain Pte. Ltd. (UEN 202627181H) trading as https://www.babybrain.sg/ ("BabyBrain").',
        'In these terms of use ("Terms"), the words "we", "our" and "us" refer to BabyBrain and "Platform" means collectively BabyBrain\'s websites, webpages and/or applications which we may manage, own or operate from time to time, each of which shall be described as a "Platform", including all content, information, applications, programmes, images/graphics, links, sounds, videos and materials which may be displayed on such Platforms, and the functions or services provided therein.',
        'By accessing and using our Platform, you confirm that you are in agreement with and legally bound by these Terms, our Terms of Service and Privacy Policy as modified from time to time. Please continue accessing our Platform only if these Terms are acceptable to you. These Terms apply only to your use of our Site and Platform. If you make bookings, purchases, or use services ("Vendor Services") offered by third-party businesses (our "Vendors") as a customer ("Client"), those are governed separately by our Terms of Service and the Vendor\'s own policies.',
      ],
    },
    {
      number: "2",
      title: "About BabyBrain",
      blocks: [
        "BabyBrain is a platform which facilitates bookings and communications between Vendors and Clients and provides scheduling, messaging and calendar integration tools, customer and waitlist management, point-of-sale functions, attendance and performance tracking and analytics and additional operational features. BabyBrain does not provide, offer, oversee or supervise any Vendor Services. Instead, we offer digital tools that help Vendors and Customers manage their operations and bookings in respect of such Vendor Services, as the case may be. BabyBrain is not a party to any Booking, service agreement or transaction between a Client and a Vendor. Vendors are independent service providers and are not employees, agents, joint ventures or contractors of BabyBrain. Vendors fully control their services, pricing, booking policies, customer relationships and compliance with applicable laws and regulations.",
        "BabyBrain does not itself process payments or hold funds. Payments and balances are processed by a third-party payment processor, and the relevant Vendor is the merchant of record for such transactions. See our Terms of Service.",
      ],
    },
    {
      number: "3",
      title: "Age Requirements",
      blocks: [
        "You must be at least 18 years old to use our Platform and Services. By accessing and using the same, you hereby represent and warrant that you are at least 18 years old.",
      ],
    },
    {
      number: "4",
      title: "Account Creation and Security",
      blocks: [
        "You may access certain parts of our Platform without creating an account. To use our Services, you must create either account as a Vendor or Client (as applicable) and provide accurate information as requested on and prompted by our Platform, including but not limited to:",
        [
          "Your name and business registration number (as applicable)",
          "Contact information",
          "Staff information (as applicable)",
          "Payment details (for subscription payments and Bookings)",
        ],
        "You agree to:",
        [
          "Keep your login credentials secure",
          "Ensure all information is accurate and up to date",
          "Ensure all users who have access to your account are your authorised representatives",
          "Accept full responsibility for all actions and activities taken by you or any third party through your account",
          "Notify BabyBrain immediately upon learning of any unauthorised use of your account or any other breach of security",
        ],
        "BabyBrain reserves the right to refuse, suspend, or terminate any account that violates these Terms.",
      ],
    },
    {
      number: "5",
      title: "Intellectual Property",
      blocks: [
        'All intellectual property rights and copyrights in the content displayed on our Platform ("Content"), including all features and functionality (including but not limited to all information, software, text, displays, images, video and audio and the design, selection and arrangement thereof), belong to BabyBrain or its licensors, as the case may be. The Platform and all Services provided (which includes all software therein) is, and will remain, the property of BabyBrain. All such rights are reserved by BabyBrain and its licensors, as the case may be. BabyBrain grants you a revocable, non-exclusive, non-sublicensable, non-transferable, limited license to download, install and use our Platform strictly in accordance with these Terms and solely as necessary for you to access and view our Platform.',
      ],
    },
    {
      number: "6",
      title: "Content",
      blocks: [
        "BabyBrain may allow you to upload information, reviews, business details or other Content. You warrant and represent that any Content submitted or uploaded by you to us will comply with these Terms. Your Content must not be illegal or unlawful, infringe any person's legal rights or any other terms and conditions, or be capable of giving rise to legal action against any person (in each case in any jurisdiction and under any applicable law). Further, your Content, and the use of your Content by us in accordance with these Terms, must not:",
        [
          "be untrue, false, inaccurate or misleading;",
          "be libellous or maliciously false, obscene or indecent;",
          "infringe any copyright, moral right, database right, trade mark right, design right, right in passing off, or other intellectual property right, or any right of confidence, right of privacy or right under data protection legislation;",
          "constitute negligent advice or contain any negligent statement;",
          "constitute an incitement to commit a crime, instructions for the commission of a crime or the promotion of criminal activity;",
          "be in contempt of any court, or in breach of any court order;",
          "be in breach of racial or religious hatred or any applicable laws and regulations;",
          "be in breach of any contractual or confidentiality obligation owed to any person;",
          "be pornographic, lewd, suggestive or sexually explicit or depict violence;",
          "consist of or contain any instructions, advice or other information which may be acted upon and could, if acted upon, cause illness, injury or death, or any other loss or damage;",
          "constitute spam;",
          "be offensive, defaming, blasphemous, deceptive, fraudulent, threatening, abusive, harassing, anti-social, menacing, hateful, embarrassing, discriminatory or inflammatory;",
          "cause annoyance, inconvenience or needless anxiety to any person; or",
          "be provided with an intention to impersonate any other person, misrepresent your identity or your affiliation with any person, or to give a false impression that your Content comes from another person.",
        ],
        "BabyBrain has no obligation to oversee, check, review, modify or remove any Content that breaches these Terms. However, if BabyBrain finds content in breach of these Terms or applicable law, we may modify or remove such Content in our sole discretion.",
        "You hereby grant BabyBrain a worldwide, irrevocable, non-exclusive, perpetual, royalty-free licence to:",
        [
          "use, reproduce, store, adapt, publish, translate and distribute your Content in any existing or future media;",
          "reproduce, store and publish your Content on and in relation to our Platform and any successor Platform;",
          "manage, edit, adapt, and improve your Content that you created on our Platform;",
          "use your Content that you provided to us or that you made publicly available for our own marketing, advertising and commercial purposes; and",
          "sub-licence the above.",
        ],
      ],
    },
    {
      number: "7",
      title: "Privacy",
      blocks: ["Your use of our Platform is governed by our Privacy Policy."],
    },
    {
      number: "8",
      title: "Features",
      blocks: [
        'BabyBrain may from time to time provide enhancements or improvements to the features/functionality of our Platform and Services, which may include patches, bug fixes, updates, upgrades and other modifications ("Updates"). Updates may modify or delete certain features and/or functionalities of our Platform and Services. You agree that BabyBrain has no obligation to: (a) provide any Updates; or (b) continue to provide or enable any particular features and/or functionalities of our Platform and/or Services to you. You further agree that all Updates will be: (i) deemed to constitute an integral part of our Platform and Services; and (ii) subject to these Terms.',
        "We reserve the right to change prices, scope and/or contents of our Services and our resources usage policy at any time without prior notice, save that we shall notify you prior to any substantial increase in price. Subject to applicable laws, if you disagree with any proposed price increase, your sole remedy shall be to cancel your Subscription in accordance with the terms herein, and your continued use of the Services without such termination constitutes your agreement to the increased price.",
      ],
    },
    {
      number: "9",
      title: "Information Rights",
      blocks: [
        'BabyBrain will not share any data that may be collected, processed or stored using the Services with respect to the characteristics and activities of users of the Platform ("Client Data") with any third parties unless it: (a) has your consent for any Client Data to be shared in accordance with any relevant privacy policy; (b) concludes that it is required by applicable law or has a good faith belief that access, preservation or disclosure of Client Data is reasonably necessary to protect the rights, property or safety of BabyBrain, its users or the public; or (c) provides Client Data in certain limited circumstances to third parties to carry out tasks on BabyBrain\'s behalf (e.g., billing or data storage) with strict restrictions that prevent the data from being used or shared except as directed by BabyBrain. When this is done, it is subject to agreements that oblige those parties to process Client Data only on BabyBrain\'s express instructions and in compliance with these Terms and appropriate confidentiality and security measures.',
      ],
    },
    {
      number: "10",
      title: "Restrictions",
      blocks: [
        "You agree not to, and you will procure that others do not:",
        [
          "Breach or attempt to breach any applicable laws and regulations.",
          "Reproduce, republish, upload, post, copy, imitate, store, archive, license, sell, rent, lease, assign, distribute, transmit, host, outsource, disclose or otherwise commercially exploit our Platform and Services, or make our Platform and Services available to any third party, save as permitted herein.",
          "Modify, make derivative works of, disassemble, decrypt, reverse compile or reverse engineer any part of our Platform and Services, or otherwise attempt to discover the source code of any software on our Platform. Downloading any software, files, images or data accompanying such software from our Platform and Services does not in any way transfer title of such software to you.",
          "Remove, alter or obscure any proprietary notice (including any notice of copyright or trademark) of BabyBrain or its affiliates, partners, suppliers or the licensors of our Platform and Services.",
          "Use, post, transmit or introduce any device, software or routine which interferes or attempts to interfere with the operation of our Platform and Services.",
          "Do any act that will or may interfere with our Platform's and our Services' accessibility and/or proper functioning, or that will or may place an unreasonable or disproportionately large load on BabyBrain's or its licensors' servers, or use automated tools (including bots and scrapers) without our consent.",
        ],
        "You hereby represent, warrant and undertake that you shall comply with all applicable laws and regulations in your use of and access to the Platform and Services.",
        "If you print, copy or download any part of our Platform in breach of these Terms, your right to use our Platform and Services will cease immediately, and you must, at our option, return or destroy any copies of the materials you have made.",
      ],
    },
    {
      number: "11",
      title: "Access to our Platform and Services",
      blocks: [
        "BabyBrain reserves the right to modify, suspend or discontinue, temporarily or permanently, the Platform or any Services to which it connects, with or without notice. Subject to the provisions in our Terms of Service relating to payment of Subscription fees, you may stop using the Services at any time. You acknowledge and agree that if we disable access to your account, you may be prevented from accessing the Services, your account details, or any files, data or other materials contained in your account.",
        "BabyBrain will not be responsible for any outcome that may occur during the course of usage of our resources. The accessibility and operation of our Platform relies on platforms and technologies outside of our control. We are not able to guarantee continuous accessibility or uninterrupted operation of our Platform.",
      ],
    },
    {
      number: "12",
      title: "Third-Party Content and Services",
      blocks: [
        "Third party content (including data, information, applications and other products and services) may appear on our Platform or may be accessible via links from our Platform. BabyBrain may also integrate booking or other functionalities with third-party platforms or Vendors' backend management systems. BabyBrain shall not be responsible and assumes no liability for any infringement, mistakes, misstatements of law, defamation, libel, slander, omissions, falsehoods or profanities in the statements, opinions, representations or any other form of content contained in any third party content, functionality or services appearing on our Platform, including with respect to its accuracy, completeness, timeliness, validity, copyright compliance, legality, decency, quality or any other aspect. BabyBrain does not assume and shall not have any liability or responsibility to you or any other person or entity for any such third party content, functionality or services.",
      ],
    },
    {
      number: "13",
      title: "Links to Other Websites",
      blocks: [
        "These Terms only apply to the use of our Platform and Services. The Platform may contain links to other websites operated or controlled by other parties (including Vendors or Clients) and not operated or controlled by BabyBrain. We are not responsible for the content, accuracy or opinions expressed in such websites, and such websites are not investigated, monitored or checked for accuracy or completeness by us. Access to any other website is at your own risk, and BabyBrain relinquishes all responsibility and liability for the use of these linked websites. Please remember that when you use a link to go from our Platform to another website, these Terms are no longer in effect. Your browsing and interaction on any other website, including those that have a link on our Platform, is subject to that website's own rules and policies. Such third parties may use their own cookies or other methods to collect information about you.",
        "You may link to our home page, provided you do so in a way that is legal and not likely to damage our reputation or take advantage of it, but you must not establish a link in such a way as to suggest any form of association, approval or endorsement on our part where none exists.",
        "We reserve the right to object to, disable or withdraw any link or frame to or from our Platform without notice.",
      ],
    },
    {
      number: "14",
      title: "Term and Termination",
      blocks: [
        "These Terms shall remain in effect until terminated by you or us.",
        "BabyBrain may, in its sole discretion, at any time and for any or no reason, suspend or terminate your account, these Terms and the provision of our Services with or without prior notice. BabyBrain may also terminate these Terms and the provision of our Services at any time without prior notice where you fail to comply with any Term herein.",
        "You may stop using our Platform at any time.",
        "Termination of these Terms will not limit any of BabyBrain's rights or remedies at law or in equity in case of breach by you of any of your obligations under these Terms.",
      ],
    },
    {
      number: "15",
      title: "No Warranties",
      blocks: [
        'Our Platform and Services are provided to you "AS IS" and "AS AVAILABLE" and with all faults and defects without warranty of any kind. To the maximum extent permitted under applicable law, BabyBrain, on its own behalf and on behalf of our affiliates and our and their respective licensors and service providers, expressly disclaims all warranties, whether express, implied, statutory or otherwise, with respect to our Platform, Services and/or Vendor Services, including all implied warranties of merchantability, fitness for a particular purpose, title and non-infringement, accuracy or availability, and warranties that may arise out of course of dealing, course of performance, usage or trade practice.',
        "Without limitation to the foregoing, BabyBrain provides no warranty or undertaking, and makes no representation or guarantee of any kind, that our Platform and Services and/or Vendor Services will meet your requirements, achieve any intended results, be compatible or work with any other software, systems, browsers or services, operate without interruption, meet any performance or reliability standards, or be error free, or that any errors or defects can or will be corrected.",
        "Without limiting the foregoing, neither BabyBrain nor any of our providers makes any representation or warranty of any kind, express or implied: (a) as to the operation or availability of our Platform and Services and/or Vendor Services, or the information, content, and materials or products included thereon; (b) that the Platform and Services and/or Vendor Services will be uninterrupted or error-free; (c) as to the accuracy, reliability, or currency of any information or content provided through our Platform and Services and/or Vendor Services; (d) that our Platform, its servers, the content, or e-mails sent from or on behalf of BabyBrain are free of viruses, scripts, trojan horses, worms, malware, timebombs or other harmful components; or (e) as to the quality, safety, legality, fulfilment or outcome of any Vendor Services, whether in public, private, or offline interactions, or about the accreditation, registration or licence of any professional involved in providing any Vendor Services.",
        "You use the Platform at your own risk.",
      ],
    },
    {
      number: "16",
      title: "Limitation of Liability",
      blocks: [
        "TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, UNDER NO CIRCUMSTANCES (INCLUDING BUT NOT LIMITED TO NEGLIGENCE) SHALL BABYBRAIN OR ITS SUPPLIERS BE LIABLE FOR ANY DAMAGE OR LOSS WHICH YOU SUSTAIN AS A RESULT OF ANY BOOKING MADE THROUGH OUR PLATFORM, INCLUDING WITHOUT LIMITATION ANY SPECIAL, INCIDENTAL, INDIRECT, OR CONSEQUENTIAL DAMAGES WHATSOEVER (INCLUDING, BUT NOT LIMITED TO, DAMAGES FOR LOSS OF PROFITS, INCOME, REVENUE, CONTRACTS OR COMMERCIAL OPPORTUNITIES, FOR LOSS OF DATA OR OTHER INFORMATION, FOR BUSINESS INTERRUPTION, FOR PERSONAL OR BODILY INJURY, DEATH OR EMOTIONAL DISTRESS, FOR DAMAGE TO PROPERTY, FOR LOSS OF PRIVACY ARISING OUT OF OR IN ANY WAY RELATED TO THE USE OF OR INABILITY TO USE OUR PLATFORM, SERVICES, VENDOR SERVICES, THIRD-PARTY SOFTWARE AND/OR THIRD-PARTY HARDWARE USED WITH OUR PLATFORM AND SERVICES, OR OTHERWISE IN CONNECTION WITH ANY OF THESE TERMS), EVEN IF REASONABLY FORESEEABLE OR IF BABYBRAIN HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES OR LOSSES.",
        "BabyBrain accepts no responsibility or liability (including, but not limited to, any direct or consequential loss or damage that might occur to you or any other third party) arising out of, or in connection with, sharing personal or sensitive information through our internal messenger or communicating or transacting with Clients outside of our Platform. Further, BabyBrain has no control over any conduct of any Vendor or Client and disclaims all liability in this regard to the maximum extent permitted by applicable law.",
        "BabyBrain cannot and does not guarantee, and is not responsible for, the truthfulness or accuracy of the identities of Vendors or Clients or the Content submitted or provided to our Platform, including any medical information.",
        "In no event shall our total liability to you exceed the total Subscription fees paid by you to us in the past 12 months.",
      ],
    },
    {
      number: "17",
      title: "Indemnification",
      blocks: [
        "To the furthest extent permitted by applicable law, you agree to indemnify and hold BabyBrain, its directors, management, employees, agents and affiliates harmless from any third party claims, liability, damages and/or costs, including but not limited to legal fees, due to or arising out of: (a) Content you submit, post, transmit or make available through our Platform; (b) your use of or connection to our Platform and Services and/or Vendor Services; (c) your breach of these Terms; (d) your violation of any rights of or obligations to another or any applicable laws; (e) your use of any analytics or data provided to you pursuant to our Services; (f) any claims made by or on behalf of any third party to which you provide access to your account or for which you use the Service to collect information on such party's behalf (\"Third Party\") pertaining directly or indirectly to your use of our Platform and Services; (g) any claims with respect to acts or omissions of any Third Party in connection with our Platform and Services and/or Vendor Services; (h) any payment handling, cancellation or refund policies, chargebacks or payment disputes; (i) any interaction or communication between Vendors and Clients; or (j) your handling, use or management of Client Data. BabyBrain will provide you with written notice of any relevant claim, suit or action. You will cooperate as fully as reasonably required in the defense of any claim.",
      ],
    },
    {
      number: "18",
      title: "Illegality",
      blocks: [
        "The illegality, invalidity or unenforceability of any Term hereunder under the law of any jurisdiction shall not affect its legality, validity or enforceability under the law of any other jurisdiction, nor the legality, validity or enforceability of any other Term hereunder.",
      ],
    },
    {
      number: "19",
      title: "Waiver",
      blocks: [
        "No failure on the part of either of us to exercise, and no delay on its part in exercising, any right or remedy under these Terms will operate as a waiver thereof, nor will any single or partial exercise of any right or remedy preclude any other or further exercise thereof or the exercise of any other right or remedy. The rights provided in these Terms are cumulative and not exclusive of any rights or remedies provided by law. Either of us may release or compromise the liability hereunder of the other party, or grant to such party time or other indulgence, without affecting the liability of such party hereunder.",
      ],
    },
    {
      number: "20",
      title: "Entire Agreement",
      blocks: [
        "These Terms and the documents referred to in it (including the Terms of Service and the Privacy Policy) constitute the entire agreement between you and BabyBrain regarding your use of our Platform and our Services, and supersede all prior and contemporaneous written or oral agreements, offers and negotiations between you and BabyBrain. You have not agreed to these Terms in reliance upon any representation, warranty or undertaking of the other party which is not set out or referred to in these Terms, save that you may be subject to additional terms and conditions that apply when you use or purchase certain/additional Services, which BabyBrain will provide to you at the time of such use or purchase.",
      ],
    },
    {
      number: "21",
      title: "Updates to Our Terms",
      blocks: [
        "These Terms may be edited, modified or deleted from time to time at our sole discretion, without notifying you. Where a revision is considered in our sole discretion to be material, we may provide at least 30 days' notice prior to such revision taking effect. Updated versions of the Terms will be posted on our Platform and are effective immediately. Your continued use of and access to our Platform and Services after any modifications to the Terms indicates your acceptance of the same, as modified.",
      ],
    },
    {
      number: "22",
      title: "Confidentiality",
      blocks: [
        'All information or materials provided to or disclosed to the other party (or by a third party on their behalf) by BabyBrain, and all information that either of us and those working for us or on our behalf had access to, been entrusted with and/or become acquainted with in connection with the production and delivery of the Services under these Terms, which are not the subject of general public knowledge, shall be deemed to be confidential information ("Confidential Information"). Each of us shall only use the other party\'s Confidential Information for the purposes of the provision and acceptance of Services under these Terms, and for no other purpose. Each of us shall take steps to prevent, protect and avoid unauthorised disclosure, use and reproduction of the other party\'s Confidential Information. Each of us shall not, during or after the term of the provision of Services, disclose or use any such Confidential Information of the other party without first obtaining the other party\'s written authorisation. Each of us shall, at the other party\'s request, require those engaged by either of us to sign confidentiality agreements, in which such persons agree not to use or disclose the other party\'s Confidential Information.',
        'With respect to any Service features which are identified as "Alpha" or "Beta" or as otherwise preliminary, experimental or confidential ("Beta Features"), you may not disclose any information relating to such Beta Features or the terms or existence of any such Beta Features. You hereby agree that BabyBrain has no liability arising out of or relating to any Beta Features. Any use of and access to Beta Features shall be at your own risk and may be subject to additional requirements as specified by BabyBrain. BabyBrain is not obliged to provide support for Beta Features, and it may, in its sole discretion, cease providing Beta Features at any time, for any reason.',
        "These Terms impose no obligations with respect to information which: (a) was in either party's possession before receipt from the disclosing party; (b) is or becomes a matter of public knowledge through no fault of the receiving party; (c) was rightfully disclosed to the receiving party by a third party without restriction on disclosure; or (d) is developed by the receiving party without use of the Confidential Information, as can be shown by documentary evidence. The receiving party may make disclosures to the extent required by applicable law, government authorities or court order, provided the receiving party makes commercially reasonable efforts to provide the disclosing party with notice of such disclosure as promptly as possible and uses diligent efforts to limit such disclosure and obtain confidential treatment or a protective order, and has allowed the disclosing party to participate in the proceeding.",
      ],
    },
    {
      number: "23",
      title: "Rights of Third Parties",
      blocks: [
        "Any person who is not a party to these Terms shall have no right under the Contracts (Rights of Third Parties) Act 2001 of Singapore to enforce any Term.",
      ],
    },
    {
      number: "24",
      title: "Governing Law",
      blocks: [
        "The access and use of our Platform and Services and its Content, and these Terms, shall be governed by and construed in accordance with the laws of the Republic of Singapore.",
        "In the event a dispute or difference arises between you and us as to any matter of whatsoever nature arising under these Terms or in connection therewith, you or we must give the other party a Notice of Dispute, which is a written statement that sets forth the name, address, and contact information of the party giving it, the facts giving rise to the dispute, and the relief requested. You must send any Notice of Dispute via email to: hello@babybrain.sg. We will send any Notice of Dispute to you by mail to your email address. You and BabyBrain will use reasonable endeavours in good faith to resolve any dispute through informal negotiation within sixty (60) days from the date such Notice of Dispute is sent. Neither party may commence legal proceedings in respect of the Dispute until the expiry of such 60-day period, except where permitted by applicable law.",
        "Subject to the dispute resolution procedure above, the parties hereto agree to submit to the non-exclusive jurisdiction of the courts of Singapore.",
      ],
    },
    {
      number: "25",
      title: "Feedback",
      blocks: [
        "In the event that you submit, share or post any feedback, comments, ideas, creative suggestions, designs, photographs, information, advertisements, data or proposals, including ideas for new or improved products, services, features, technologies or promotions, you expressly agree that such submissions will automatically be treated as non-confidential and non-proprietary and will become the sole and exclusive property of BabyBrain without any compensation or credit to you whatsoever. BabyBrain and its affiliates shall have no obligations with respect to such feedback, submissions or posts, and may copy, modify, publish, redistribute or otherwise use the ideas contained in such submissions or posts for any purpose in any medium in perpetuity, including but not limited to developing, manufacturing, and marketing products and services using such ideas, without any credit or compensation to you.",
      ],
    },
    {
      number: "26",
      title: "Miscellaneous",
      blocks: [
        "BabyBrain operates our Platform and Services from our offices in Singapore. Our Platform and Services are not intended for distribution to or use by any person or entity in any jurisdiction or country where such distribution or use would be contrary to applicable law or regulation. Accordingly, persons who choose to access our Platform and Services from other locations do so on their own initiative and are solely responsible for compliance with local laws, if and to the extent local laws are applicable.",
        "BabyBrain shall perform the Services as an independent contractor, and nothing in these Terms shall be deemed to create any association, partnership, joint venture, or relationship of principal and agent or master and servant between BabyBrain and any Client or Vendor or any of our affiliates or subsidiaries, or to provide either BabyBrain or any Client or Vendor with the right, power or authority, whether express or implied, to create any such duty or obligation on behalf of the other party.",
      ],
    },
    {
      number: "27",
      title: "Contact Us",
      blocks: ["Don't hesitate to contact us if you have any questions. Email: hello@babybrain.sg."],
    },
  ],
};

const PRIVACY: LegalDoc = {
  key: "privacy",
  label: "Privacy Policy",
  shortLabel: "Privacy",
  updated: "9 September 2026",
  intro: [
    "This website and platform are directed only to residents of Singapore. BabyBrain's services are intended for use by individuals located in Singapore, and our handling of personal data is governed by the Singapore Personal Data Protection Act 2012 (the \"PDPA\"). If you are accessing our platform from outside Singapore, you do so on your own initiative and are responsible for compliance with your local laws.",
  ],
  sections: [
    {
      number: "1",
      title: "Introduction",
      blocks: [
        "This Privacy Policy explains how BabyBrain collects, uses, discloses, protects and retains your personal data, and the rights available to you under the PDPA.",
        'We are BabyBrain Pte. Ltd. (UEN 202627181H), a company incorporated in Singapore with its registered office at 133 New Bridge Road, #23-09, Chinatown Point, Singapore 059413, trading as BabyBrain at www.babybrain.sg ("BabyBrain", "we", "our", "us").',
        'In this Policy, "Platform" means our websites, webpages and applications and the services provided through them; "Vendor" means a business that lists activities, classes or events on the Platform; "Client" or "parent" means a customer who browses or makes a booking; and "personal data" has the meaning given to it under the PDPA.',
        "BabyBrain is a marketplace platform that connects parents with children's enrichment activities and helps Vendors and Clients manage bookings and communications. We are not the provider of the activities themselves, and we are not a party to any booking between a Client and a Vendor.",
        "By creating an account, making a booking, or otherwise using the Platform, you acknowledge that you have read and understood this Policy and, where required, consent to our collection, use and disclosure of your personal data as described here.",
      ],
    },
    {
      number: "2",
      title: "Data Protection Officer",
      blocks: [
        'We have appointed a Data Protection Officer ("DPO") responsible for overseeing our compliance with the PDPA. You may contact our DPO about anything in this Policy, including access, correction or withdrawal-of-consent requests:',
        ["Data Protection Officer: Katie Crowson", "Email: hello@babybrain.sg"],
      ],
    },
    {
      number: "3",
      title: "Personal data we collect",
      blocks: [
        "The personal data we collect depends on how you use the Platform.",
        "**3.1 From parents (Clients)** — When you create an account or use the Platform, we may collect:",
        [
          "Your full name",
          "Email address",
          "Password (stored in encrypted form)",
          "Phone number",
          "Postcode (used to show activities near you)",
          "The areas and preferences you select (for example, preferred regions, days, times and price ranges)",
        ],
        "**3.2 About your child** — Because BabyBrain helps you find and book children's activities, we collect limited information about your child that you provide as the account holder:",
        [
          "Your child's name",
          "Date of birth",
          'Sex (you may choose "prefer not to say")',
          "Activity interests you select",
        ],
        "When you make a booking, the relevant Vendor may also ask you to provide, and you may choose to disclose:",
        [
          "Medical, allergy or dietary information about your child, where relevant to the safe delivery of an activity",
          "Address and contact information for sessions held out of your home",
        ],
        "This information is sensitive and is treated with additional care — see Section 7 (Children's personal data) for how we handle it.",
        "**3.3 From Vendors** — When a business registers as a Vendor, we may collect:",
        [
          "Business name and business address",
          "Business email and business phone",
          "Unique Entity Number (UEN), used to verify the registered business",
          "Listing, location/branch and pricing information",
          "Details of team members or staff whom the Vendor invites to their account (for example, name and email address)",
        ],
        "Where a Vendor provides us with personal data about its staff or other individuals, the Vendor is responsible for ensuring it is authorised to do so.",
        "**3.4 Payment information** — Payments are processed by our third-party payment processor (currently Stripe). Card and payment details are entered directly with the payment processor through its secure technology. BabyBrain does not collect or store your full card or bank details.",
        "**3.5 Information collected automatically** — When you use the Platform, we (and our service providers) may collect technical and usage information such as device and browser type, IP address, and how you interact with the Platform, including through cookies and similar technologies — see Section 15 (Cookies and analytics).",
      ],
    },
    {
      number: "4",
      title: "How we collect personal data",
      blocks: [
        "We collect personal data:",
        [
          "Directly from you, when you register, complete forms, make a booking, or communicate with us or with Vendors through the Platform;",
          "Automatically, through your use of the Platform; and",
          "From third parties where relevant, such as our payment processor confirming a transaction.",
        ],
      ],
    },
    {
      number: "5",
      title: "Purposes for which we use personal data",
      blocks: [
        "We collect, use and disclose personal data for purposes that a reasonable person would consider appropriate in the circumstances, including to:",
        [
          "Create and manage your account;",
          "Match parents with suitable activities and show relevant recommendations;",
          "Facilitate, confirm and manage bookings and communications between Clients and Vendors;",
          "Pass necessary booking details to the relevant Vendor so the activity can be delivered safely (see Section 6);",
          "Process subscription payments and enable booking payments through our payment processor;",
          "Provide customer support and respond to enquiries and complaints;",
          "Send you service-related communications and, where you have consented, marketing communications about BabyBrain and relevant activities;",
          "Operate, maintain, secure and improve the Platform;",
          "Detect, prevent and address fraud, misuse and security issues; and",
          "Comply with applicable laws, regulations and lawful requests.",
        ],
        "Where we rely on your consent, you may withdraw it as described in Section 12. Where the PDPA permits us to collect, use or disclose personal data without consent (for example, for certain legal, security or business-asset-transaction purposes), we may do so in accordance with the law.",
      ],
    },
    {
      number: "6",
      title: "What we share with Vendors",
      blocks: [
        "When you make a booking, we share with the relevant Vendor only the information the Vendor needs to deliver the activity.",
        "Each Vendor is an independent organisation, and once your information is shared with them, the Vendor is responsible for handling it in accordance with the PDPA and its own privacy practices. We encourage you to review the Vendor's own policies.",
        "**Photographs at activities** — Some Vendors ask parents whether they consent to photographs being taken during an activity (for example, for the Vendor's own social media). Where you give this consent, any resulting photographs are collected and stored by the Vendor, not by BabyBrain. The Vendor is responsible for those images as a separate organisation. Photo consent is optional and is not required to make a booking.",
      ],
    },
    {
      number: "7",
      title: "Children's personal data",
      blocks: [
        "BabyBrain is a service for adults. You must be at least 18 years old to create an account and use the Platform. Children do not hold accounts and are not the intended users of the Platform.",
        "Where information about a child is provided, it is provided by the parent or guardian who holds the account, acting on the child's behalf. By providing your child's information, you confirm that you are the child's parent or legal guardian (or are otherwise authorised to provide it) and that you consent, on the child's behalf, to our collection, use and disclosure of that information as described in this Policy.",
        "We limit children's data to what is needed to help you find and book activities. Sensitive information — such as medical, allergy or dietary details — is collected only where you choose to provide it for a booking, is shared only with the relevant Vendor for the safe delivery of that activity, and is otherwise protected as described in Section 9.",
        "If you believe a child's personal data has been provided to us without proper authority, please contact our DPO and we will take appropriate steps to address it.",
      ],
    },
    {
      number: "8",
      title: "Disclosure of personal data",
      blocks: [
        "We may disclose personal data:",
        [
          "To Vendors, as described in Section 6, to enable your bookings;",
          "To service providers who process personal data on our behalf, as described in Section 10;",
          "In connection with a business transfer, as described in Section 16;",
          "Where required or permitted by law, including to comply with legal obligations, respond to lawful requests from public authorities, or protect our rights, safety and property or those of others.",
        ],
        "We do not sell your personal data.",
      ],
    },
    {
      number: "9",
      title: "Protection of personal data",
      blocks: [
        "We make reasonable security arrangements to protect personal data in our possession or control against unauthorised access, collection, use, disclosure, copying, modification, disposal or similar risks. These include access controls, encryption of passwords and payment handling through our payment processor's secure technology.",
        "No method of transmission or storage is completely secure, and while we strive to protect your personal data, we cannot guarantee absolute security.",
      ],
    },
    {
      number: "10",
      title: "Third-party service providers and AI tools",
      blocks: [
        "To operate the Platform, we use reputable third-party providers that may process personal data on our behalf as our data intermediaries. These fall into categories such as:",
        [
          "Payment processing;",
          "Cloud hosting and data storage;",
          "Customer relationship management (CRM);",
          "Email, messaging and communications;",
          "Analytics; and",
          "Artificial-intelligence tools that support features or operations.",
        ],
        "Some of these providers, and the technologies they use, may change from time to time as our Platform develops. Where a third party processes personal data on our behalf, we remain responsible under the PDPA for that personal data and take reasonable steps to ensure our providers offer a standard of protection comparable to the PDPA.",
      ],
    },
    {
      number: "11",
      title: "Transfer of personal data outside Singapore",
      blocks: [
        "Some of our service providers store or process personal data outside Singapore. Where we transfer personal data overseas, we comply with the PDPA's Transfer Limitation Obligation by taking reasonable steps to ensure that the receiving organisation is bound by legally enforceable obligations to provide a standard of protection at least comparable to that under the PDPA (for example, through contractual terms).",
        "By using the Platform, you acknowledge that your personal data may be transferred to, and processed in, jurisdictions outside Singapore for the purposes described in this Policy.",
      ],
    },
    {
      number: "12",
      title: "Consent and withdrawal of consent",
      blocks: [
        "Where we rely on your consent to collect, use or disclose your personal data, you may withdraw that consent at any time by contacting our DPO at hello@babybrain.sg, giving reasonable notice.",
        "If you withdraw consent, we will inform you of the likely consequences — in particular, we may no longer be able to provide certain features or fulfil bookings. Withdrawing consent does not affect the lawfulness of anything done before withdrawal, and we may continue to retain and use personal data where the law permits or requires (for example, to complete a transaction already underway or to comply with legal obligations).",
        "You may also unsubscribe from marketing communications at any time using the unsubscribe link in those messages, without affecting service-related communications.",
      ],
    },
    {
      number: "13",
      title: "Access and correction",
      blocks: [
        "Under the PDPA, you may request:",
        [
          "Access to the personal data we hold about you and information about how it has been used or disclosed; and",
          "Correction of any personal data that is inaccurate or out of date.",
        ],
        "To make a request, contact our DPO at hello@babybrain.sg. We may need to verify your identity before responding, and we will respond within the timeframes required by the PDPA. A reasonable fee may apply to certain access requests, and we will inform you in advance if so.",
      ],
    },
    {
      number: "14",
      title: "Accuracy",
      blocks: [
        "We rely on you to keep your information accurate and up to date. Please update your account details, or contact us, if your personal data changes.",
      ],
    },
    {
      number: "15",
      title: "Cookies and analytics",
      blocks: [
        "We use cookies and similar technologies to operate the Platform, remember your preferences, improve performance through caching, and understand how the Platform is used so that we can improve it. The cookies and technologies we use include:",
        [
          "Essential cookies that are necessary for the Platform to function and to keep you signed in;",
          "Preference cookies that remember your settings and choices;",
          "Caching, which temporarily stores data to make the Platform load faster; and",
          "Analytics cookies from third-party analytics services (such as Google Analytics), which help us understand how visitors use the Platform. These services may collect information such as your IP address, device and browser type, and the pages you visit, and may set their own cookies.",
        ],
        "You can control or disable cookies through your browser settings, and you can opt out of Google Analytics using the tools Google provides. Disabling some cookies may affect how the Platform works.",
      ],
    },
    {
      number: "16",
      title: "Business transfers / change of control",
      blocks: [
        "If BabyBrain is involved in a merger, acquisition, financing, reorganisation, sale of assets, or other transaction in which our business or assets are transferred, personal data held by us may be transferred as part of that transaction, subject to the acquiring party continuing to handle it in accordance with this Policy or a materially similar policy.",
        "The PDPA permits the collection, use and disclosure of personal data for the purposes of such a business asset transaction without fresh consent, subject to the conditions set out in the PDPA. Where any such transfer proceeds and notification is required, we will provide notice as required by law.",
      ],
    },
    {
      number: "17",
      title: "Retention of personal data",
      blocks: [
        "There is no single fixed retention period prescribed by the PDPA. We retain personal data for as long as your account remains active and for as long as is necessary to fulfil the purposes set out in this Policy, or as required to comply with our legal, accounting or regulatory obligations.",
        [
          "If you close your account, your personal data is deleted from our active systems immediately, except where we are required or permitted by law to retain certain information (for example, transaction records). For a short period after deletion, residual copies may remain in our secure encrypted backups for up to 7 days before being permanently overwritten.",
          "We will cease to retain personal data, or remove the means by which it can be associated with you, when it is reasonable to assume that retention no longer serves the purposes for which it was collected and is no longer necessary for legal or business purposes.",
        ],
      ],
    },
    {
      number: "18",
      title: "Third-party links",
      blocks: [
        "The Platform may contain links to third-party websites or services (including Vendors' own sites). We are not responsible for the privacy practices or content of those third parties, and this Policy does not apply to them. Please review their privacy policies before providing personal data.",
      ],
    },
    {
      number: "19",
      title: "Changes to this Policy",
      blocks: [
        'We may update this Policy from time to time. The "Last updated" date at the top shows when it was last revised. Where changes are material, we will take reasonable steps to notify you. Your continued use of the Platform after any update constitutes acceptance of the revised Policy.',
      ],
    },
    {
      number: "20",
      title: "How to contact us and make a complaint",
      blocks: [
        "For any questions, requests or complaints about this Policy or your personal data, please contact:",
        [
          "Data Protection Officer: Katie Crowson",
          "Email: hello@babybrain.sg",
          "BabyBrain Pte. Ltd. (UEN 202627181H), 133 New Bridge Road, #23-09, Chinatown Point, Singapore 059413",
        ],
        "We will endeavour to respond to your request or resolve your complaint within a reasonable time. If you are not satisfied with our response, you may have the right to lodge a complaint with the Personal Data Protection Commission (PDPC) of Singapore.",
      ],
    },
    {
      number: "21",
      title: "Governing law",
      blocks: ["This Policy is governed by and construed in accordance with the laws of the Republic of Singapore."],
    },
  ],
};

export const LEGAL_DOCS: LegalDoc[] = [TOS, TOU, PRIVACY];
