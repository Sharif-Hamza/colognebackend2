import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase client
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

// Configure CORS with specific options
app.use(cors({
  origin: process.env.FRONTEND_URL.replace(/\/$/, ''), // Remove trailing slash if present
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // Cache preflight request for 24 hours
}));

// Parse JSON payloads
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl === '/webhook') {
      req.rawBody = buf.toString();
    }
  }
}));

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Cologne Ologist API',
    status: 'running',
    endpoints: ['/create-checkout-session', '/checkout-session/:sessionId', '/webhook']
  });
});

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, userId, email, shippingOption, coupon } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Invalid items data' });
    }

    const lineItems = items.map(item => {
      // Create the product data object
      const productData = {
        name: item.name,
        description: item.description,
        metadata: {
          productId: item.id
        }
      };
      
      // Only add images if image_url exists and is not empty
      if (item.image_url && item.image_url.trim() !== '') {
        productData.images = [item.image_url];
        productData.metadata.image_url = item.image_url;
      }
      
      return {
        price_data: {
          currency: 'usd',
          product_data: productData,
          unit_amount: item.price,
        },
        quantity: item.quantity,
      };
    });

    // Generate a UUID for the order
    const orderId = randomUUID();

    // Ensure the URL doesn't have double slashes
    const baseUrl = process.env.FRONTEND_URL.replace(/\/+$/, '');
    
    // Define shipping options
    const shippingOptions = [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: {
            amount: 499,
            currency: 'usd',
          },
          display_name: 'Standard Shipping',
          delivery_estimate: {
            minimum: {
              unit: 'business_day',
              value: 5,
            },
            maximum: {
              unit: 'business_day',
              value: 7,
            },
          },
        },
      },
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: {
            amount: 999,
            currency: 'usd',
          },
          display_name: 'Express Shipping',
          delivery_estimate: {
            minimum: {
              unit: 'business_day',
              value: 2,
            },
            maximum: {
              unit: 'business_day',
              value: 3,
            },
          },
        },
      },
    ];
    
    // Calculate subtotal
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    // Initialize variables for tax and discount
    let taxAmount = 0;
    let discountAmount = 0;
    let couponId = null;
    let couponCode = null;
    let skipShipping = false;
    let skipTax = false;
    
    // Apply coupon if provided
    if (coupon) {
      couponId = coupon.id;
      couponCode = coupon.code;
      
      // Handle different discount types
      if (coupon.discount_type === 'fixed_amount') {
        discountAmount = Math.min(coupon.discount_value, subtotal);
      } else if (coupon.discount_type === 'percentage') {
        discountAmount = Math.round((coupon.discount_value / 100) * subtotal);
      } else if (coupon.discount_type === 'free_shipping') {
        // For free_shipping type, we skip shipping
        skipShipping = true;
      } else if (coupon.discount_type === 'no_tax') {
        // For no_tax type, we skip tax
        skipTax = true;
      } else if (coupon.discount_type === 'full_discount') {
        // For full_discount type, we skip both tax and shipping
        skipShipping = true;
        skipTax = true;
      }
    }
    
    // Calculate tax (8.875% for NY) if not using a tax-exemption coupon
    if (!skipTax) {
      const taxRate = 0.08875;
      taxAmount = Math.round(subtotal * taxRate);
    }
    
    // Prepare line items based on coupon type
    let allLineItems = [...lineItems];
    
    // Add tax line item if not using a shipping_tax coupon
    if (!skipShipping && taxAmount > 0) {
      const taxLineItem = {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Sales Tax (8.875%)',
            description: 'NY State and Local Sales Tax',
          },
          unit_amount: taxAmount,
        },
        quantity: 1,
      };
      allLineItems.push(taxLineItem);
    }
    
    // Add discount line item if applicable
    if (discountAmount > 0) {
      const discountLineItem = {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Discount: ${couponCode}`,
            description: 'Coupon code discount',
          },
          unit_amount: -discountAmount, // Negative amount for discount
        },
        quantity: 1,
      };
      allLineItems.push(discountLineItem);
    }
    
    // Create checkout session
    const sessionParams = {
      customer_email: email,
      payment_method_types: ['card'],
      line_items: allLineItems,
      mode: 'payment',
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/cart`,
      metadata: {
        userId,
        orderId,
        taxAmount,
        couponId: couponId || '',
        couponCode: couponCode || '',
        discountAmount: discountAmount.toString()
      },
      billing_address_collection: 'required',
      tax_id_collection: {
        enabled: true,
      },
      // Disable automatic tax since we're calculating it manually
      automatic_tax: {
        enabled: false,
      }
    };
    
    // Only add shipping options and collection if not using a shipping_tax coupon
    if (!skipShipping) {
      sessionParams.shipping_options = shippingOptions;
      sessionParams.shipping_address_collection = {
        allowed_countries: ['US']
      };
    }
    
    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ 
      message: error.message || 'An error occurred while creating the checkout session'
    });
  }
});

// Retrieve session details
app.get('/checkout-session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price.product', 'customer_details', 'payment_intent', 'shipping_cost', 'total_details']
    });

    res.json({
      customer: {
        name: session.customer_details?.name || 'N/A',
        email: session.customer_details?.email || 'N/A'
      },
      items: session.line_items?.data.map(item => ({
        description: item.description,
        quantity: item.quantity,
        amount_total: item.amount_total,
        image_url: item.price.product.metadata.image_url
      })) || [],
      total: session.amount_total,
      shipping: {
        cost: session.shipping_cost?.amount_total || 0,
        name: session.shipping_cost?.shipping_rate?.display_name || 'Standard Shipping'
      },
      tax: {
        amount: session.metadata?.taxAmount || 0
      },
      subtotal: session.total_details?.amount_subtotal || 0
    });
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(500).json({ message: 'Failed to retrieve order details' });
  }
});

// Webhook endpoint for handling Stripe events
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      // Retrieve the session with line items
      const expandedSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items.data.price.product', 'shipping_cost', 'total_details']
      });

      // Prepare order items data
      const orderItems = expandedSession.line_items.data
        .filter(item => item.price.product.metadata.productId) // Filter out tax and discount line items
        .map(item => {
          // Create the order item with required fields
          const orderItem = {
            product_id: item.price.product.metadata.productId,
            quantity: item.quantity,
            price_at_time: item.price.unit_amount
          };
          
          // Only add image_url if it exists in metadata
          if (item.price.product.metadata.image_url) {
            orderItem.image_url = item.price.product.metadata.image_url;
          }
          
          return orderItem;
        });

      // Extract shipping and tax information
      const shippingCost = expandedSession.shipping_cost?.amount_total || 0;
      const shippingName = expandedSession.shipping_cost?.shipping_rate?.display_name || 'Standard Shipping';
      const taxAmount = parseInt(session.metadata.taxAmount) || 0;
      
      // Extract coupon information
      const couponId = session.metadata.couponId || null;
      const couponCode = session.metadata.couponCode || null;
      const discountAmount = parseInt(session.metadata.discountAmount) || 0;

      // Call the database function to process the webhook
      const { error } = await supabase.rpc('process_stripe_webhook', {
        session_id: session.id,
        user_id: session.metadata.userId,
        order_id: session.metadata.orderId,
        total: session.amount_total,
        items: orderItems,
        shipping_cost: shippingCost,
        shipping_name: shippingName,
        tax_amount: taxAmount,
        coupon_id: couponId,
        coupon_code: couponCode,
        discount_amount: discountAmount
      });

      if (error) {
        console.error('Error processing webhook:', error);
        throw error;
      }
      
      // If a coupon was used, update its usage count
      if (couponId) {
        await supabase.rpc('update_coupon_usage', {
          p_coupon_id: couponId,
          p_user_id: session.metadata.userId
        });
      }

      console.log('Order processed successfully:', {
        orderId: session.metadata.orderId,
        sessionId: session.id
      });
    } catch (error) {
      console.error('Error processing successful payment:', error);
      return res.status(500).json({ message: 'Error processing payment success' });
    }
  }

  res.json({ received: true });
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`CORS enabled for origin: ${process.env.FRONTEND_URL.replace(/\/$/, '')}`);
});
